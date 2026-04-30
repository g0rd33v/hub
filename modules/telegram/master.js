// modules/telegram/master.js — @LabsHubBot master coordinator
//
// Two audiences:
//   OWNER  — the person whose chat_id is stored in /etc/hub/owner.id
//             Full control: projects, signin links, server stats, new project.
//             First person to send /start becomes owner (if no owner.id yet).
//   PUBLIC — anyone else. Gets a clean Hub welcome + link to hub.labs.co.
//
// Commands (owner only):
//   /start       — welcome + quick status
//   /projects    — list all projects with live URLs and PAP signin links
//   /new <name>  — create a new project
//   /signin      — get your SAP signin link
//   /status      — server health summary
//   /help        — command list
//
// Commands (public):
//   /start       — Hub welcome message
//   /help        — same welcome

import fs   from 'fs';
import path from 'path';

let _ctx;
let _botInfo  = null;
let _polling  = false;
let _offset   = 0;
let _ownerChatId = null;

export const hooks = {
  onDraftsBoot:      () => {},
  onVersionBump:     () => {},
  onSchemaMigration: () => {},
  onNewProject:      () => {},
  onMainCommit:      () => {},
  onAAPMerged:       () => {},
  onNewAAPCreated:   () => {},
};

// ─── token + owner ───────────────────────────────────────────────────────────

function tokenPath()  { return _ctx.paths.masterBotToken(); }
function ownerPath()  { return path.join(_ctx.config.configDir, 'owner.id'); }

function loadToken() {
  const legacy = '/etc/labs/drafts.tbp';
  if (fs.existsSync(legacy)) {
    try {
      const raw = fs.readFileSync(legacy, 'utf8').trim();
      try { const p = JSON.parse(raw); if (p.token) return p.token; } catch {}
      if (/^\d+:[A-Za-z0-9_-]{30,}$/.test(raw)) return raw;
    } catch {}
  }
  const p = tokenPath();
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (/^\d+:[A-Za-z0-9_-]{30,}$/.test(raw)) return raw;
  }
  return null;
}

function loadOwner() {
  const p = ownerPath();
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p, 'utf8').trim();
    if (raw) return String(raw);
  }
  return null;
}

function saveOwner(chatId) {
  _ownerChatId = String(chatId);
  try { fs.writeFileSync(ownerPath(), _ownerChatId + '\n', { mode: 0o600 }); } catch {}
}

function isOwner(chatId) {
  return _ownerChatId && String(chatId) === _ownerChatId;
}

// ─── Telegram API ─────────────────────────────────────────────────────────────

async function tg(token, method, params = {}) {
  const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params),
  });
  return res.json();
}

async function send(token, chatId, text, extra = {}) {
  return tg(token, 'sendMessage', {
    chat_id:    chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

async function setCommands(token) {
  // Owner scope — only visible to owner in their client
  await tg(token, 'setMyCommands', {
    commands: [
      { command: 'start',    description: 'Status overview' },
      { command: 'projects', description: 'List all projects' },
      { command: 'new',      description: 'Create project: /new name' },
      { command: 'signin',   description: 'Get your server signin link' },
      { command: 'status',   description: 'Server health' },
      { command: 'help',     description: 'Command list' },
    ],
    scope: { type: 'all_private_chats' },
  });
}

// ─── polling ──────────────────────────────────────────────────────────────────

async function startPolling(token) {
  _polling = true;
  const log = _ctx.logger.child('master-bot');
  while (_polling) {
    try {
      const r = await tg(token, 'getUpdates', {
        offset: _offset, timeout: 25,
        allowed_updates: ['message', 'callback_query'],
      });
      if (r.ok && r.result?.length) {
        for (const upd of r.result) {
          _offset = upd.update_id + 1;
          try { await dispatch(token, upd); } catch (e) { log.error('dispatch error:', e.message); }
        }
      }
    } catch (e) {
      log.error('polling error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(token, upd) {
  const msg    = upd.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text   = msg.text.trim();
  const cmd    = text.split(' ')[0].replace(/@.*$/, '').toLowerCase();
  const args   = text.slice(cmd.length).trim();

  // First /start ever → claim ownership
  if (!_ownerChatId && cmd === '/start') {
    saveOwner(chatId);
    return handleOwnerStart(token, chatId);
  }

  if (isOwner(chatId)) {
    switch (cmd) {
      case '/start':    return handleOwnerStart(token, chatId);
      case '/projects': return handleProjects(token, chatId);
      case '/new':      return handleNew(token, chatId, args);
      case '/signin':   return handleSignin(token, chatId);
      case '/status':   return handleStatus(token, chatId);
      case '/help':     return handleOwnerHelp(token, chatId);
      default:          return send(token, chatId, 'Unknown command. Send /help for the list.');
    }
  } else {
    return handlePublic(token, chatId);
  }
}

// ─── owner handlers ───────────────────────────────────────────────────────────

async function handleOwnerStart(token, chatId) {
  const state    = _ctx.modules.drafts?.getState() || { projects: [] };
  const count    = state.projects.length;
  const botCount = state.projects.filter(p => p.bot?.token).length;
  const base     = _ctx.config.publicBase;
  const sap      = require_sap();
  const sapHex   = sap.replace(/^0x/, '');
  const signinUrl = `${base}/signin/pass_0_server_${sapHex}`;

  await send(token, chatId,
    `<b>Hub</b> — running.

` +
    `<b>${count}</b> project${count !== 1 ? 's' : ''}  ·  <b>${botCount}</b> bot${botCount !== 1 ? 's' : ''} active
` +
    `Server: <code>${base}</code>

` +
    `<a href="${signinUrl}">Open server dashboard</a>

` +
    `/projects — list everything
/new name — create project
/status — full health check`
  );
}

async function handleProjects(token, chatId) {
  const state  = _ctx.modules.drafts?.getState() || { projects: [] };
  const base   = _ctx.config.publicBase;
  const sn     = _ctx.config.serverNumber;

  if (!state.projects.length) {
    return send(token, chatId, 'No projects yet. Send /new name to create one.');
  }

  const lines = state.projects.map(p => {
    const papSecret = p.pap?.token?.replace(/^pap_/, '');
    const signinUrl = papSecret ? `${base}/signin/pass_${sn}_project_${papSecret}` : null;
    const liveUrl   = `${base}/${p.name}/`;
    const botTag    = p.bot?.token ? ` · @${p.bot.bot_username}` : '';
    const link      = signinUrl ? `<a href="${signinUrl}">${p.name}</a>` : `<b>${p.name}</b>`;
    return `${link}${botTag}\n<a href="${liveUrl}">${liveUrl}</a>`;
  });

  await send(token, chatId,
    `<b>${state.projects.length} project${state.projects.length !== 1 ? 's' : ''}</b>\n\n` +
    lines.join('\n\n')
  );
}

async function handleNew(token, chatId, args) {
  const name = args.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  if (!name) {
    return send(token, chatId, 'Usage: /new projectname\n\nName must be lowercase letters, numbers, hyphens, underscores.');
  }

  try {
    const sap  = require_sap();
    const body = JSON.stringify({ name });
    const res  = await fetch(`${_ctx.config.publicBase.replace('https://', 'http://localhost:3100').replace('http://hub.labs.co', 'http://localhost:3100')}/drafts/projects`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${sap}`, 'Content-Type': 'application/json' },
      body,
    });
    // Use localhost directly
    const res2 = await fetch('http://localhost:3100/drafts/projects', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${sap}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res2.json();
    if (data.ok) {
      await send(token, chatId,
        `<b>${name}</b> created.\n\n` +
        `Live: <a href="${data.live_url}">${data.live_url}</a>\n` +
        `Dashboard: <a href="${data.pap_activation_url}">open PAP</a>`
      );
    } else {
      await send(token, chatId, `Failed: ${data.error}`);
    }
  } catch (e) {
    await send(token, chatId, `Error: ${e.message}`);
  }
}

async function handleSignin(token, chatId) {
  const sap   = require_sap();
  const base  = _ctx.config.publicBase;
  const url   = `${base}/signin/pass_0_server_${sap}`;
  await send(token, chatId,
    `Your server dashboard:\n<a href="${url}">${url}</a>\n\n<i>This link gives full server access. Don't share it.</i>`
  );
}

async function handleStatus(token, chatId) {
  try {
    const sap = require_sap();
    const r   = await fetch('http://localhost:3100/health');
    const h   = await r.json();
    const state = _ctx.modules.drafts?.getState() || { projects: [] };
    const botCount = state.projects.filter(p => p.bot?.token).length;
    const upMin = Math.floor(h.uptime_sec / 60);

    await send(token, chatId,
      `<b>Hub ${h.version}</b> — ${h.ok ? 'online' : 'degraded'}\n\n` +
      `Modules: ${h.modules.join(', ')}\n` +
      `Projects: ${state.projects.length}  ·  Bots: ${botCount}\n` +
      `Uptime: ${upMin}m\n` +
      `Server: ${_ctx.config.publicBase}`
    );
  } catch (e) {
    await send(token, chatId, `Health check failed: ${e.message}`);
  }
}

async function handleOwnerHelp(token, chatId) {
  await send(token, chatId,
    `<b>Hub commands</b>\n\n` +
    `/start — status overview\n` +
    `/projects — list all projects with links\n` +
    `/new name — create a new project\n` +
    `/signin — get your server dashboard link\n` +
    `/status — server health\n` +
    `/help — this list`
  );
}

// ─── public handler ───────────────────────────────────────────────────────────

async function handlePublic(token, chatId) {
  const base = _ctx.config.publicBase;
  await send(token, chatId,
    `<b>Hub</b> — connect everything. Manage from chat.\n\n` +
    `Hub lets you run bots, sites, apps, and APIs — all from one place. ` +
    `Every project gets a live URL, git versioning, and a Telegram bot in one step.\n\n` +
    `<a href="${base}">${base}</a>`
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function require_sap() {
  const { getSAP } = _ctx.credentials || {};
  if (getSAP) return getSAP();
  // Fallback: read directly
  try { return fs.readFileSync('/etc/hub/sap.token', 'utf8').trim(); } catch { return ''; }
}

export function getTelegramStatus() {
  const token = loadToken();
  return { installed: !!token, bot: _botInfo || null, polling: _polling };
}

// ─── module contract ──────────────────────────────────────────────────────────

export async function init(ctx) {
  _ctx = ctx;
  _ownerChatId = loadOwner();

  const token = loadToken();
  if (!token) { ctx.logger.info('[master-bot] no token found, skipping'); return; }

  const me = await tg(token, 'getMe');
  if (!me.ok) { ctx.logger.warn('[master-bot] getMe failed:', me.description); return; }
  _botInfo = me.result;
  ctx.logger.info('[master-bot] connected as @' + _botInfo.username +
    (_ownerChatId ? ` (owner: ${_ownerChatId})` : ' (no owner yet — first /start claims)'));

  await setCommands(token).catch(() => {});
  startPolling(token).catch(e => ctx.logger.error('[master-bot] polling crashed:', e.message));
}

export function mountRoutes(app, ctx) {}
