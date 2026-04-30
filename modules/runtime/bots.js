// modules/runtime/bots.js — bot.js loader + dispatcher
// Lifted from drafts/runtime.js. KV comes from ctx.modules.buffer.

import fs   from 'fs';
import path from 'path';
import { loadUserModule, getOrMakeLogger, safeGlobals } from './sandbox.js';

const RUNTIME_TIMEOUT_MS = 5000;

// projectName → { module, mtime, importErr }
const registry = new Map();

let _ctx;
export async function init(ctx) { _ctx = ctx; }

function livePath(projectName) {
  return path.join(_ctx.config.dataDir, 'projects', projectName, 'live', 'bot.js');
}

export function hasBotJs(projectName) {
  return fs.existsSync(livePath(projectName));
}

async function ensureLoaded(projectName) {
  if (!hasBotJs(projectName)) { registry.delete(projectName); return null; }
  const lp   = livePath(projectName);
  const stat = fs.statSync(lp);
  const cached = registry.get(projectName);
  if (cached && cached.mtime === stat.mtimeMs && !cached.importErr) return cached;

  const logger = getOrMakeLogger(projectName);
  const kv     = _ctx.modules.buffer.getKv(projectName);
  try {
    const { module } = await loadUserModule(lp, logger, 'function');
    const entry = { module, mtime: stat.mtimeMs, kv, importErr: null };
    registry.set(projectName, entry);
    logger.info('[bots] loaded bot.js');
    return entry;
  } catch (e) {
    const entry = { module: null, mtime: stat.mtimeMs, kv, importErr: e.message };
    registry.set(projectName, entry);
    logger.error('[bots] bot.js failed to load:', e.message);
    return entry;
  }
}

function extractUserId(update) {
  if (!update || typeof update !== 'object') return null;
  if (update.message?.from) return update.message.from.id;
  if (update.callback_query?.from) return update.callback_query.from.id;
  if (update.edited_message?.from) return update.edited_message.from.id;
  return null;
}

function makeSend(getToken) {
  async function api(method, params = {}) {
    const token = getToken();
    if (!token) throw new Error('send: no bot token');
    const res  = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) { const err = new Error('telegram_api: ' + (data.description || 'unknown')); err.code = data.error_code; throw err; }
    return data.result;
  }
  return {
    api,
    message:        (chat_id, text, opts = {}) => api('sendMessage',    { chat_id, text, parse_mode: opts.parse_mode || 'HTML', ...opts }),
    editMessage:    (chat_id, message_id, text, opts = {}) => api('editMessageText', { chat_id, message_id, text, parse_mode: opts.parse_mode || 'HTML', ...opts }),
    answerCallback: (cqi, text, opts = {}) => api('answerCallbackQuery', { callback_query_id: cqi, text, ...opts }),
  };
}

export async function dispatchBotUpdate(project, update) {
  const entry = await ensureLoaded(project.name);
  if (!entry) return { handled: false, reason: 'no_bot_js' };
  if (!entry.module || typeof entry.module.default !== 'function') {
    return { handled: false, reason: 'no_default_export', error: entry.importErr };
  }
  const logger = getOrMakeLogger(project.name);
  const ctx = {
    kv:           entry.kv,
    send:         makeSend(() => project.bot?.token),
    log:          (...a) => logger.info(...a),
    project:      project.name,
    user_id:      extractUserId(update),
    bot_username: project.bot?.bot_username,
    now:          new Date().toISOString(),
  };
  try {
    await Promise.race([
      Promise.resolve(entry.module.default(update, ctx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('handler timeout (' + RUNTIME_TIMEOUT_MS + 'ms)')), RUNTIME_TIMEOUT_MS)),
    ]);
    return { handled: true };
  } catch (e) {
    logger.error('[bots] handler threw:', e.message);
    return { handled: true, error: e.message };
  }
}

export async function dispatchCron(project, handlerName) {
  const entry = await ensureLoaded(project.name);
  if (!entry?.module) return { handled: false, reason: 'no_bot_js' };
  const fn = entry.module[handlerName];
  if (typeof fn !== 'function') return { handled: false, reason: 'no_handler' };
  const logger = getOrMakeLogger(project.name);
  const ctx = {
    kv: entry.kv,
    send: makeSend(() => project.bot?.token),
    log: (...a) => logger.info(...a),
    project: project.name,
    user_id: null,
    bot_username: project.bot?.bot_username,
    now: new Date().toISOString(),
    cron: handlerName,
  };
  try {
    await Promise.race([
      Promise.resolve(fn(ctx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cron timeout')), RUNTIME_TIMEOUT_MS)),
    ]);
    return { handled: true };
  } catch (e) {
    logger.error('[bots] cron', handlerName, 'threw:', e.message);
    return { handled: true, error: e.message };
  }
}
