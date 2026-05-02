// runner.js — hub-bot-runner v0.5.0
// Runs a single Telegram bot in isolation inside its own Docker container.
// Loads user code from /app/user/bot.js (read-only mount).
//
// ABI for user code:
//   /app/user/bot.js MUST export a default async function setup(bot, ctx)
//   See README.md for the full bot/ctx API surface.
//
// Environment:
//   BOT_TOKEN  required — Telegram bot token from @BotFather
//
// Exit codes:
//   0  graceful shutdown via SIGTERM/SIGINT
//   1  fatal: BOT_TOKEN missing/malformed, or forced exit after 10s shutdown timeout
//   2  fatal: Telegram auth (getMe) failed

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(TOKEN)) {
  console.error('FATAL: BOT_TOKEN missing or malformed');
  process.exit(1);
}

const API = 'https://api.telegram.org/bot' + TOKEN;
const USER_BOT_PATH = '/app/user/bot.js';

const handlers = { message: [], callback_query: [], inline_query: [], any: [] };
const inFlight = new Set();
let shuttingDown = false;
let me = null;

// ─── Telegram API wrapper ──────────────────────────────────────────────────
async function call(method, params = {}, opts = {}) {
  const ctrl = new AbortController();
  inFlight.add(ctrl);
  const timeoutId = setTimeout(() => ctrl.abort('timeout'), opts.timeoutMs || 35000);
  try {
    const r = await fetch(API + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    const data = await r.json();
    if (!data.ok) throw new Error('tg ' + method + ': ' + (data.description || 'unknown'));
    return data.result;
  } finally {
    clearTimeout(timeoutId);
    inFlight.delete(ctrl);
  }
}

const bot = {
  call,
  sendMessage:         (chat_id, text, extra = {})    => call('sendMessage', { chat_id, text, ...extra }),
  sendPhoto:           (chat_id, photo, extra = {})   => call('sendPhoto', { chat_id, photo, ...extra }),
  editMessageText:     (params)                       => call('editMessageText', params),
  answerCallbackQuery: (id, extra = {})               => call('answerCallbackQuery', { callback_query_id: id, ...extra }),
  deleteMessage:       (chat_id, message_id)          => call('deleteMessage', { chat_id, message_id }),
  getMe:               ()                              => call('getMe'),
};

// ─── Context for user code ───────────────────────────────────────────────────────
function makeCtx() {
  return {
    on(event, fn) {
      if (typeof fn !== 'function') throw new Error('ctx.on(' + event + ', fn): fn must be a function');
      const list = handlers[event];
      if (!list) throw new Error('ctx.on: unknown event "' + event + '". Use one of: ' + Object.keys(handlers).join(', '));
      list.push(fn);
    },
    log: (...a) => console.log('[user]', ...a),
    env: { ...process.env, BOT_TOKEN: '[REDACTED]' },
    me: () => me,
  };
}

// ─── User code loader ───────────────────────────────────────────────────────────
async function loadUserBot() {
  const fs = await import('fs');
  if (!fs.existsSync(USER_BOT_PATH)) {
    console.warn('[runner] no ' + USER_BOT_PATH + ' found — running idle (no handlers)');
    return;
  }
  try {
    const mod = await import('file://' + USER_BOT_PATH);
    const setup = mod.default;
    if (typeof setup !== 'function') {
      console.error('[runner] user bot.js: no default export function — running idle');
      return;
    }
    await setup(bot, makeCtx());
    const total = Object.values(handlers).reduce((s, l) => s + l.length, 0);
    console.log('[runner] user setup() complete — ' + total + ' handler(s) registered');
  } catch (e) {
    console.error('[runner] user setup() failed:', e.message);
    if (e.stack) console.error(e.stack);
    // Don't exit — idle, so Docker doesn't restart-loop us forever
  }
}

// ─── Update dispatch ────────────────────────────────────────────────────────────
async function dispatch(update) {
  const tasks = [];
  for (const fn of handlers.any) tasks.push(safeRun('any', fn, update));
  if (update.message)         for (const fn of handlers.message)         tasks.push(safeRun('message', fn, update.message));
  if (update.callback_query)  for (const fn of handlers.callback_query)  tasks.push(safeRun('callback_query', fn, update.callback_query));
  if (update.inline_query)    for (const fn of handlers.inline_query)    tasks.push(safeRun('inline_query', fn, update.inline_query));
  await Promise.all(tasks);
}

async function safeRun(event, fn, payload) {
  try { await fn(payload); }
  catch (e) {
    console.error('[handler:' + event + '] threw:', e.message);
    if (e.stack) console.error(e.stack);
  }
}

// ─── Polling loop ────────────────────────────────────────────────────────────────
async function poll() {
  let offset = 0;
  while (!shuttingDown) {
    try {
      const updates = await call('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query', 'inline_query'],
      });
      for (const upd of updates) {
        offset = upd.update_id + 1;
        // Background dispatch — don't block polling on slow handlers
        dispatch(upd).catch(e => console.error('[dispatch]', e.message));
      }
    } catch (e) {
      if (shuttingDown) break;
      console.error('[poll] error:', e.message);
      await new Promise(r => setTimeout(r, 5000));  // backoff on transient errors
    }
  }
  console.log('[runner] polling stopped');
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[runner] received ' + sig + ', shutting down...');
  // Abort all in-flight requests so the polling loop exits immediately
  for (const ctrl of inFlight) {
    try { ctrl.abort('shutdown'); } catch {}
  }
  // Hard kill if not done in 10s
  setTimeout(() => {
    console.error('[runner] forced exit after 10s timeout');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (e) => console.error('[uncaught]', e.message, e.stack || ''));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || String(e)));

// ─── Boot ─────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('[runner] hub-bot-runner v0.5.0 starting');
  try {
    me = await bot.getMe();
    console.log('[runner] authenticated as @' + me.username + ' (id=' + me.id + ')');
  } catch (e) {
    console.error('[runner] FATAL: bot auth failed:', e.message);
    process.exit(2);
  }
  await loadUserBot();
  await poll();
  console.log('[runner] exit 0');
  process.exit(0);
})();
