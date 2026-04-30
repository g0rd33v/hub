// modules/telegram/master.js — @LabsHubBot (master coordinator bot)
// Lifted from drafts/telegram.js. Renamed entry points for v0.2 module shape.
// Polling-based (no webhook on master bot).

import fs   from 'fs';
import path from 'path';

let _ctx;
let _botInfo = null;
let _polling = false;
let _offset  = 0;

// Notification hooks — called by drafts module on key events.
export const hooks = {
  onDraftsBoot:        () => {},
  onVersionBump:       () => {},
  onSchemaMigration:   () => {},
  onNewProject:        () => {},
  onMainCommit:        () => {},
  onAAPMerged:         () => {},
  onNewAAPCreated:     () => {},
};

function tokenPath() {
  return _ctx.paths.masterBotToken();
}

function loadToken() {
  // v0.1 legacy path first, then new path
  const legacy = '/etc/labs/drafts.tbp';
  if (fs.existsSync(legacy)) {
    try {
      const raw = fs.readFileSync(legacy, 'utf8').trim();
      // Could be JSON {token:"...", bot:{...}} or plain token string
      try {
        const parsed = JSON.parse(raw);
        if (parsed.token) return parsed.token;
      } catch {}
      if (/^\d+:[A-Za-z0-9_-]{30,}$/.test(raw)) return raw;
    } catch {}
  }
  const newPath = tokenPath();
  if (fs.existsSync(newPath)) {
    const raw = fs.readFileSync(newPath, 'utf8').trim();
    if (/^\d+:[A-Za-z0-9_-]{30,}$/.test(raw)) return raw;
  }
  return null;
}

async function tgApi(token, method, params = {}) {
  const res  = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  return res.json();
}

async function startPolling(token) {
  _polling = true;
  const log = _ctx.logger.child('master-bot');
  while (_polling) {
    try {
      const result = await tgApi(token, 'getUpdates', { offset: _offset, timeout: 20, allowed_updates: ['message','callback_query'] });
      if (result.ok && result.result?.length) {
        for (const update of result.result) {
          _offset = update.update_id + 1;
          try { await handleUpdate(token, update); } catch (e) { log.error('update error:', e.message); }
        }
      }
    } catch (e) {
      log.error('polling error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function handleUpdate(token, update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text   = msg.text || '';

  if (text === '/start' || text.startsWith('/start ')) {
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: '<b>Hub</b> \u2014 running.\n\nSend /projects to list all projects on this server.',
      parse_mode: 'HTML',
    });
    return;
  }

  if (text === '/projects' || text === '/list') {
    const state    = _ctx.modules.drafts?.getState();
    const projects = state?.projects || [];
    if (!projects.length) {
      await tgApi(token, 'sendMessage', { chat_id: chatId, text: 'No projects yet. Create one with POST /drafts/projects.' });
      return;
    }
    const lines = projects.map(p =>
      `• <b>${p.name}</b> — <a href="${_ctx.config.publicBase}/${p.name}/">${_ctx.config.publicBase.replace(/^https?:\/\//,'')}/${p.name}/</a>`
    );
    await tgApi(token, 'sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true });
    return;
  }

  // Unrecognised
  await tgApi(token, 'sendMessage', {
    chat_id: chatId,
    text: 'Commands: /projects',
    parse_mode: 'HTML',
  });
}

export function getTelegramStatus() {
  const token = loadToken();
  return {
    installed: !!token,
    bot:       _botInfo || null,
    polling:   _polling,
    users_count: 0, // maintained by project bots module
  };
}

export async function init(ctx) {
  _ctx = ctx;
  const token = loadToken();
  if (!token) { ctx.logger.info('[master-bot] no token found, skipping'); return; }

  const me = await tgApi(token, 'getMe');
  if (!me.ok) { ctx.logger.warn('[master-bot] getMe failed:', me.description); return; }
  _botInfo = me.result;
  ctx.logger.info('[master-bot] connected as @' + _botInfo.username);

  // Non-blocking
  startPolling(token).catch(e => ctx.logger.error('[master-bot] polling crashed:', e.message));
}

export function mountRoutes(app, ctx) {
  // Master bot uses long-polling; no HTTP webhook routes needed in v0.2.
}
