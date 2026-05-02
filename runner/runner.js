// runner.js — hub-bot-runner v0.6.0
// Hub-compatible ABI: same `ctx` surface as Hub's modules/runtime/bots.js,
// so existing project bot.js files run unmodified inside isolated containers.
//
// User code contract (matches Hub runtime exactly):
//   /app/user/bot.js MUST export: default async function handler(update, ctx)
//   /app/user/cron.json (optional) declares scheduled named exports:
//     [
//       { "schedule": "0 9 * * *", "handler": "broadcast" },        // daily 09:00 UTC
//       { "schedule": "* * * * *", "handler": "broadcastWallQueue" } // every minute
//     ]
//   Cron handler signature: async function name(ctx)  // ctx has cron:'name', user_id:null
//
// Required environment:
//   BOT_TOKEN  Telegram bot token from @BotFather
//   PROJECT    project name (used by ctx.project AND for KV proxy URL scoping)
//   HUB_URL    base URL of Hub for KV proxy (e.g. http://host.docker.internal:3100)
//   KV_TOKEN   HMAC-SHA256(SAP, "<bot_id>:<project>") — minted by botctl at spawn
//
// Exit codes:
//   0  graceful shutdown via SIGTERM/SIGINT
//   1  fatal config error (missing/bad env vars)
//   2  Telegram getMe auth failed
//   3  KV proxy unreachable at startup

import fs from 'fs';

const TOKEN    = process.env.BOT_TOKEN;
const PROJECT  = process.env.PROJECT;
const HUB_URL  = (process.env.HUB_URL || 'http://host.docker.internal:3100').replace(/\/$/, '');
const KV_TOKEN = process.env.KV_TOKEN;

if (!TOKEN || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(TOKEN)) {
  console.error('FATAL: BOT_TOKEN missing or malformed'); process.exit(1);
}
if (!PROJECT)  { console.error('FATAL: PROJECT env missing');  process.exit(1); }
if (!KV_TOKEN) { console.error('FATAL: KV_TOKEN env missing'); process.exit(1); }

const TG_API         = 'https://api.telegram.org/bot' + TOKEN;
const USER_BOT_PATH  = '/app/user/bot.js';
const USER_CRON_PATH = '/app/user/cron.json';

let shuttingDown = false;
let me = null;
let userMod = null;
const inFlight   = new Set();
const cronTimers = [];

// ─── Telegram API ────────────────────────────────────────────────────────────
async function tgCall(method, params = {}, opts = {}) {
  const ctrl = new AbortController();
  inFlight.add(ctrl);
  const tid = setTimeout(() => ctrl.abort('timeout'), opts.timeoutMs || 35000);
  try {
    const r = await fetch(TG_API + '/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    const data = await r.json();
    if (!data.ok) throw new Error('tg ' + method + ': ' + (data.description || 'unknown'));
    return data.result;
  } finally {
    clearTimeout(tid);
    inFlight.delete(ctrl);
  }
}

// ─── KV proxy back to Hub ────────────────────────────────────────────────────
async function kvCall(op, body) {
  const ctrl = new AbortController();
  inFlight.add(ctrl);
  const tid = setTimeout(() => ctrl.abort('timeout'), 5000);
  try {
    const r = await fetch(HUB_URL + '/internal/kv/' + op, {
      method: 'POST',
      headers: {
        'content-type':   'application/json',
        'authorization':  'Bearer ' + KV_TOKEN,
        'x-hub-project':  PROJECT,
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const data = await r.json();
    if (!data.ok) throw new Error('kv.' + op + ': ' + (data.error || 'unknown'));
    return data;
  } finally {
    clearTimeout(tid);
    inFlight.delete(ctrl);
  }
}

const kv = {
  async get(key)        { const r = await kvCall('get', { key }); return r.value; },
  async set(key, value) { await kvCall('set', { key, value }); },
  async delete(key)     { await kvCall('del', { key }); },
  async del(key)        { await kvCall('del', { key }); },
};

// ─── ctx.send (matches Hub's makeSend shape exactly) ─────────────────────────────────────
const send = {
  message:         (chat_id, text,  extra = {}) => tgCall('sendMessage',  { chat_id, text, ...extra }),
  photo:           (chat_id, photo, extra = {}) => tgCall('sendPhoto',    { chat_id, photo, ...extra }),
  document:        (chat_id, document, extra = {}) => tgCall('sendDocument', { chat_id, document, ...extra }),
  audio:           (chat_id, audio, extra = {}) => tgCall('sendAudio',    { chat_id, audio, ...extra }),
  voice:           (chat_id, voice, extra = {}) => tgCall('sendVoice',    { chat_id, voice, ...extra }),
  video:           (chat_id, video, extra = {}) => tgCall('sendVideo',    { chat_id, video, ...extra }),
  chatAction:      (chat_id, action) => tgCall('sendChatAction', { chat_id, action }),
  edit:            (params) => tgCall('editMessageText', params),
  editReplyMarkup: (params) => tgCall('editMessageReplyMarkup', params),
  delete:          (chat_id, message_id) => tgCall('deleteMessage', { chat_id, message_id }),
  answerCallback:  (callback_query_id, extra = {}) => tgCall('answerCallbackQuery', { callback_query_id, ...extra }),
  call:            tgCall,
};

// ─── ctx builder (matches Hub's runtime/bots.js exactly) ───────────────────────────────
function makeCtx(extras = {}) {
  return {
    kv,
    send,
    log:          (...a) => console.log('[user]', ...a),
    project:      PROJECT,
    bot_username: me?.username || null,
    now:          new Date().toISOString(),
    user_id:      extras.user_id ?? null,
    cron:         extras.cron,
  };
}

function extractUserId(update) {
  return update?.message?.from?.id
      ?? update?.callback_query?.from?.id
      ?? update?.edited_message?.from?.id
      ?? null;
}

// ─── User module loader ─────────────────────────────────────────────────────────────
async function loadUserMod() {
  if (!fs.existsSync(USER_BOT_PATH)) {
    console.warn('[runner] no /app/user/bot.js — idle (no handler, no cron)');
    return;
  }
  try {
    userMod = await import('file://' + USER_BOT_PATH);
    if (typeof userMod.default !== 'function') {
      console.error('[runner] bot.js: no default export function — updates will not be dispatched');
    } else {
      const named = Object.keys(userMod).filter((k) => k !== 'default');
      console.log('[runner] loaded bot.js (default handler + ' + named.length + ' named export(s): ' + named.join(',') + ')');
    }
  } catch (e) {
    console.error('[runner] bot.js failed to load:', e.message);
    if (e.stack) console.error(e.stack);
  }
}

// ─── Update dispatch (Hub's signature: default(update, ctx)) ──────────────────────────
async function dispatchUpdate(update) {
  if (!userMod || typeof userMod.default !== 'function') return;
  const ctx = makeCtx({ user_id: extractUserId(update) });
  try {
    await userMod.default(update, ctx);
  } catch (e) {
    console.error('[handler] threw:', e.message);
    if (e.stack) console.error(e.stack);
  }
}

// ─── Cron ───────────────────────────────────────────────────────────────────────────────
function parseCronToMs(schedule) {
  if (!schedule || typeof schedule !== 'string') return null;
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  if (parts.every((p) => p === '*')) return { type: 'interval', ms: 60_000 };
  const m = parseInt(parts[0], 10);
  const h = parseInt(parts[1], 10);
  if (!Number.isInteger(m) || !Number.isInteger(h)) return null;
  if (parts[2] !== '*' || parts[3] !== '*' || parts[4] !== '*') return null;
  if (m < 0 || m > 59 || h < 0 || h > 23) return null;
  return { type: 'daily', hour: h, minute: m };
}

function msUntilNext(hour, minute) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function runCronHandler(handlerName) {
  if (!userMod) return;
  const fn = userMod[handlerName];
  if (typeof fn !== 'function') {
    console.error('[cron] handler not found:', handlerName);
    return;
  }
  const ctx = makeCtx({ cron: handlerName });
  try {
    await fn(ctx);
  } catch (e) {
    console.error('[cron:' + handlerName + '] threw:', e.message);
    if (e.stack) console.error(e.stack);
  }
}

function startCron() {
  if (!fs.existsSync(USER_CRON_PATH)) return;
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(USER_CRON_PATH, 'utf8'));
    if (!Array.isArray(entries)) throw new Error('cron.json not an array');
  } catch (e) {
    console.error('[runner] cron.json failed to parse:', e.message);
    return;
  }
  for (const entry of entries) {
    const parsed = parseCronToMs(entry.schedule);
    if (!parsed) {
      console.warn('[cron] unsupported schedule, skipped:', entry.schedule);
      continue;
    }
    if (parsed.type === 'interval') {
      const id = setInterval(() => runCronHandler(entry.handler), parsed.ms);
      cronTimers.push(id);
      console.log('[cron] scheduled ' + entry.handler + ' every ' + (parsed.ms / 1000) + 's');
    } else {
      const fire = () => {
        runCronHandler(entry.handler);
        const id = setInterval(() => runCronHandler(entry.handler), 24 * 3600 * 1000);
        cronTimers.push(id);
      };
      const delay = msUntilNext(parsed.hour, parsed.minute);
      const tid = setTimeout(fire, delay);
      cronTimers.push(tid);
      const hh = String(parsed.hour).padStart(2, '0');
      const mm = String(parsed.minute).padStart(2, '0');
      console.log('[cron] scheduled ' + entry.handler + ' daily at ' + hh + ':' + mm + ' UTC (in ' + Math.round(delay / 60000) + 'm)');
    }
  }
}

// ─── Polling loop ────────────────────────────────────────────────────────────────────
async function poll() {
  let offset = 0;
  while (!shuttingDown) {
    try {
      const updates = await tgCall('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query', 'inline_query', 'edited_message', 'my_chat_member'],
      });
      for (const upd of updates) {
        offset = upd.update_id + 1;
        dispatchUpdate(upd).catch((e) => console.error('[dispatch]', e.message));
      }
    } catch (e) {
      if (shuttingDown) break;
      console.error('[poll] error:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log('[runner] polling stopped');
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────────
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[runner] received ' + sig + ', shutting down...');
  for (const id of cronTimers) { try { clearInterval(id); clearTimeout(id); } catch {} }
  for (const c of inFlight)    { try { c.abort('shutdown'); } catch {} }
  setTimeout(() => { console.error('[runner] forced exit'); process.exit(1); }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (e) => console.error('[uncaught]', e.message, e.stack || ''));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || String(e)));

// ─── Boot ──────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('[runner] hub-bot-runner v0.6.0 starting (project=' + PROJECT + ')');
  try {
    await kvCall('ping', {});
    console.log('[runner] KV proxy reachable at ' + HUB_URL);
  } catch (e) {
    console.error('[runner] FATAL: KV proxy unreachable:', e.message);
    process.exit(3);
  }
  try {
    me = await tgCall('getMe');
    console.log('[runner] authenticated as @' + me.username + ' (id=' + me.id + ')');
  } catch (e) {
    console.error('[runner] FATAL: bot auth failed:', e.message);
    process.exit(2);
  }
  await loadUserMod();
  startCron();
  await poll();
  process.exit(0);
})();
