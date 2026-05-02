// runner.js — hub-bot-runner v0.5.1
// Runs a single Telegram bot in isolation. Hub-compatible ABI: user code can
// be lifted from Hub's drafts/projects/<name>/live/ and dropped into a
// container without changes.
//
// User code (read-only mount /app/user):
//   bot.js   — must `export default async function handler(update, ctx)`,
//              may export named async functions for cron
//   cron.json (optional) — [{schedule, handler}]
//                          schedule format: "* * * * *" -> every 60s
//                                          "M H * * *" -> daily at H:M UTC
//
// ctx shape (matches Hub modules/runtime/bots.js):
//   ctx.kv.get(key)              async, via HTTP back to Hub
//   ctx.kv.set(key, value)       async
//   ctx.kv.del(key)              async
//   ctx.send.message(chat_id, text, opts)    direct Telegram API
//   ctx.send.photo(chat_id, photo, opts)
//   ctx.send.document(chat_id, doc, opts)
//   ctx.log(...args)
//   ctx.project       project name string
//   ctx.bot_username  '@xxx'-stripped username
//   ctx.user_id       Telegram user id from update (or null for cron)
//   ctx.now           ISO timestamp string
//   ctx.cron          handler name string when called from cron, else undefined
//
// Environment:
//   BOT_TOKEN   required — Telegram bot token
//   PROJECT     required — project name (for log prefix and KV scope)
//   HUB_URL     required — base URL where Hub serves /internal/kv/* (e.g. http://host.docker.internal:3100)
//   KV_TOKEN    required — HMAC-SHA256(SAP, botId:project) bearer for KV proxy
//
// Exit codes:
//   0  graceful shutdown via SIGTERM/SIGINT
//   1  fatal: BOT_TOKEN missing/malformed; OR forced exit after 10s shutdown
//   2  fatal: Telegram getMe auth failed
//   3  fatal: required env (PROJECT, HUB_URL, KV_TOKEN) missing

import fs from 'fs';

const TOKEN     = process.env.BOT_TOKEN;
const PROJECT   = process.env.PROJECT;
const HUB_URL   = process.env.HUB_URL;
const KV_TOKEN  = process.env.KV_TOKEN;

if (!TOKEN || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(TOKEN)) {
  console.error('FATAL: BOT_TOKEN missing or malformed');
  process.exit(1);
}
if (!PROJECT || !HUB_URL || !KV_TOKEN) {
  console.error('FATAL: required env missing (PROJECT, HUB_URL, KV_TOKEN)');
  process.exit(3);
}

const API = 'https://api.telegram.org/bot' + TOKEN;
const USER_BOT_PATH  = '/app/user/bot.js';
const USER_CRON_PATH = '/app/user/cron.json';

const inFlight = new Set();
let shuttingDown = false;
let me = null;
let userMod = null;

// ─── Telegram API ──────────────────────────────────────────────────────
async function tgCall(method, params = {}, opts = {}) {
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

// Hub-compatible send.* surface
const send = {
  message:  (chat_id, text, opts = {})  => tgCall('sendMessage',  { chat_id, text,  ...opts }),
  photo:    (chat_id, photo, opts = {}) => tgCall('sendPhoto',    { chat_id, photo, ...opts }),
  document: (chat_id, document, opts = {}) => tgCall('sendDocument', { chat_id, document, ...opts }),
  audio:    (chat_id, audio, opts = {}) => tgCall('sendAudio',    { chat_id, audio, ...opts }),
  voice:    (chat_id, voice, opts = {}) => tgCall('sendVoice',    { chat_id, voice, ...opts }),
  video:    (chat_id, video, opts = {}) => tgCall('sendVideo',    { chat_id, video, ...opts }),
  chatAction: (chat_id, action) => tgCall('sendChatAction', { chat_id, action }),
  edit:     (params) => tgCall('editMessageText', params),
  editReplyMarkup: (params) => tgCall('editMessageReplyMarkup', params),
  delete:   (chat_id, message_id) => tgCall('deleteMessage', { chat_id, message_id }),
  answerCallback: (id, opts = {}) => tgCall('answerCallbackQuery', { callback_query_id: id, ...opts }),
  call:     tgCall,  // raw escape hatch for any TG method
};

// ─── KV proxy back to Hub ─────────────────────────────────────────────────
async function kvCall(op, body) {
  const ctrl = new AbortController();
  inFlight.add(ctrl);
  const timeoutId = setTimeout(() => ctrl.abort('timeout'), 5000);
  try {
    const r = await fetch(HUB_URL + '/internal/kv/' + op, {
      method: 'POST',
      headers: {
        'content-type':  'application/json',
        'authorization': 'Bearer ' + KV_TOKEN,
        'x-hub-project': PROJECT,
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const data = await r.json();
    if (!data.ok) throw new Error('kv.' + op + ': ' + (data.error || ('http ' + r.status)));
    return data;
  } finally {
    clearTimeout(timeoutId);
    inFlight.delete(ctrl);
  }
}

const kv = {
  get: async (key) => (await kvCall('get', { key })).value,
  set: async (key, value) => { await kvCall('set', { key, value }); return value; },
  del: async (key) => { await kvCall('del', { key }); return true; },
};

// ─── Context builder ────────────────────────────────────────────────────────
function extractUserId(update) {
  if (!update || typeof update !== 'object') return null;
  return update.message?.from?.id
      ?? update.callback_query?.from?.id
      ?? update.edited_message?.from?.id
      ?? update.inline_query?.from?.id
      ?? null;
}

function makeCtx({ user_id = null, cron = undefined } = {}) {
  return {
    kv,
    send,
    log: (...a) => console.log('[user]', ...a),
    project:      PROJECT,
    bot_username: me?.username || null,
    user_id,
    now:          new Date().toISOString(),
    cron,
  };
}

// ─── User code loader ───────────────────────────────────────────────────────
async function loadUserBot() {
  if (!fs.existsSync(USER_BOT_PATH)) {
    console.warn('[runner] no ' + USER_BOT_PATH + ' — running idle');
    return;
  }
  try {
    userMod = await import('file://' + USER_BOT_PATH);
    if (typeof userMod.default !== 'function') {
      console.warn('[runner] bot.js has no default export — running idle (cron-only mode)');
    } else {
      console.log('[runner] bot.js loaded, default handler ready');
    }
  } catch (e) {
    console.error('[runner] bot.js load failed:', e.message);
    if (e.stack) console.error(e.stack);
    userMod = null;
  }
}

// ─── Cron ──────────────────────────────────────────────────────────────────────
function parseCronToMs(expr) {
  // Supports the same two patterns as Hub's modules/runtime/cron.js:
  //   "* * * * *"   -> every 60s   -> { type: 'interval', ms: 60000 }
  //   "M H * * *"   -> daily HH:MM UTC -> { type: 'daily', hour, minute }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (min === '*' && hour === '*') return { type: 'interval', ms: 60 * 1000 };
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return { type: 'daily', hour: Number(hour), minute: Number(min) };
  }
  return null;
}

function msUntilNextDaily(hour, minute) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function runCronHandler(handlerName) {
  if (!userMod || typeof userMod[handlerName] !== 'function') {
    console.warn('[cron] handler not found: ' + handlerName);
    return;
  }
  try {
    await userMod[handlerName](makeCtx({ cron: handlerName }));
  } catch (e) {
    console.error('[cron] ' + handlerName + ' threw:', e.message);
    if (e.stack) console.error(e.stack);
  }
}

function startCron() {
  if (!fs.existsSync(USER_CRON_PATH)) return;
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(USER_CRON_PATH, 'utf8'));
    if (!Array.isArray(entries)) throw new Error('cron.json must be an array');
  } catch (e) {
    console.error('[cron] cron.json parse failed:', e.message);
    return;
  }
  for (const entry of entries) {
    if (!entry?.schedule || !entry?.handler) continue;
    const parsed = parseCronToMs(entry.schedule);
    if (!parsed) {
      console.warn('[cron] unsupported schedule "' + entry.schedule + '" for ' + entry.handler);
      continue;
    }
    if (parsed.type === 'interval') {
      setInterval(() => runCronHandler(entry.handler), parsed.ms);
      console.log('[cron] scheduled ' + entry.handler + ' every ' + (parsed.ms / 1000) + 's');
    } else if (parsed.type === 'daily') {
      const delay = msUntilNextDaily(parsed.hour, parsed.minute);
      setTimeout(() => {
        runCronHandler(entry.handler);
        setInterval(() => runCronHandler(entry.handler), 24 * 3600 * 1000);
      }, delay);
      const hh = String(parsed.hour).padStart(2, '0');
      const mm = String(parsed.minute).padStart(2, '0');
      console.log('[cron] scheduled ' + entry.handler + ' daily at ' + hh + ':' + mm + ' UTC (in ' + Math.round(delay / 60000) + 'm)');
    }
  }
}

// ─── Update dispatch ───────────────────────────────────────────────────────────
async function dispatch(update) {
  if (!userMod || typeof userMod.default !== 'function') return;
  const ctx = makeCtx({ user_id: extractUserId(update) });
  try {
    await userMod.default(update, ctx);
  } catch (e) {
    console.error('[handler] threw:', e.message);
    if (e.stack) console.error(e.stack);
  }
}

// ─── Polling loop ────────────────────────────────────────────────────────────
async function poll() {
  let offset = 0;
  while (!shuttingDown) {
    try {
      const updates = await tgCall('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query', 'edited_message', 'inline_query', 'my_chat_member'],
      });
      for (const upd of updates) {
        offset = upd.update_id + 1;
        dispatch(upd).catch((e) => console.error('[dispatch]', e.message));
      }
    } catch (e) {
      if (shuttingDown) break;
      console.error('[poll] error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log('[runner] polling stopped');
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[runner] received ' + sig + ', shutting down...');
  for (const ctrl of inFlight) { try { ctrl.abort('shutdown'); } catch {} }
  setTimeout(() => { console.error('[runner] forced exit after 10s timeout'); process.exit(1); }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (e) => console.error('[uncaught]', e.message, e.stack || ''));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || String(e)));

// ─── Boot ─────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('[runner] hub-bot-runner v0.5.1 starting (project=' + PROJECT + ')');
  try {
    me = await tgCall('getMe');
    console.log('[runner] authenticated as @' + me.username + ' (id=' + me.id + ')');
  } catch (e) {
    console.error('[runner] FATAL: bot auth failed:', e.message);
    process.exit(2);
  }
  // KV smoke ping (non-fatal)
  try {
    await kvCall('ping', {});
    console.log('[runner] KV proxy reachable');
  } catch (e) {
    console.warn('[runner] KV proxy ping failed (will retry on first use):', e.message);
  }
  await loadUserBot();
  startCron();
  await poll();
  process.exit(0);
})();
