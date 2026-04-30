// modules/telegram/master.js — @LabsHubBot
import fs   from 'fs';
import path from 'path';

let _ctx;
let _botInfo     = null;
let _polling     = false;
let _offset      = 0;
let _ownerChatId = null;

export const hooks = {
  onDraftsBoot: () => {}, onVersionBump: () => {}, onSchemaMigration: () => {},
  onNewProject: () => {}, onMainCommit:  () => {}, onAAPMerged: () => {}, onNewAAPCreated: () => {},
};

// —— token + owner ——

function tokenPath() { return _ctx.paths.masterBotToken(); }
function ownerPath() { return path.join(_ctx.config.configDir, 'owner.id'); }

function loadToken() {
  const legacy = '/etc/labs/drafts.tbp';
  if (fs.existsSync(legacy)) {
    try {
      const raw = fs.readFileSync(legacy,'utf8').trim();
      try { const p = JSON.parse(raw); if (p.token) return p.token; } catch {}
      if (/^\d+:[A-Za-z0-9_-]{30,}$/.test(raw)) return raw;
    } catch {}
  }
  const p = tokenPath();
  if (fs.existsSync(p)) {
    const raw = fs.readFileSync(p,'utf8').trim();
    if (/^\d+:[A-Za-z0-9_-]{30,}$/.test(raw)) return raw;
  }
  return null;
}

function loadOwner() {
  try {
    const p = ownerPath();
    if (fs.existsSync(p)) { const r = fs.readFileSync(p,'utf8').trim(); if (r) return String(r); }
  } catch {}
  return null;
}

function saveOwner(chatId) {
  _ownerChatId = String(chatId);
  try {
    fs.mkdirSync(path.dirname(ownerPath()), { recursive: true });
    fs.writeFileSync(ownerPath(), _ownerChatId+'\n', { mode: 0o600 });
    _ctx.logger.info('[master-bot] owner set to', _ownerChatId);
  } catch (e) { _ctx.logger.error('[master-bot] failed to save owner:', e.message); }
}

function isOwner(chatId) { return !!_ownerChatId && String(chatId) === _ownerChatId; }
function readSAP()       { try { return fs.readFileSync('/etc/hub/sap.token','utf8').trim(); } catch { return ''; } }

// —— Telegram API ——

async function tg(token, method, params = {}) {
  const res = await fetch('https://api.telegram.org/bot'+token+'/'+method, {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(params),
  });
  return res.json();
}

async function send(token, chatId, text, extra = {}) {
  return tg(token, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    disable_web_page_preview: true, ...extra,
  });
}

async function answerCallback(token, callbackId, text = '') {
  return tg(token, 'answerCallbackQuery', { callback_query_id: callbackId, text });
}

// Build inline keyboard: rows of buttons
// buttons = [ { text, url } ] or [ [ {text,url}, {text,url} ] ] for multi-column rows
function kbd(buttons) {
  // Auto-wrap: each button on its own row unless already nested array
  const rows = buttons.map(b => Array.isArray(b) ? b : [b]);
  return { inline_keyboard: rows };
}

async function setCommands(token, ownerChatId) {
  const common = [
    { command: 'new',   description: 'Create a project' },
    { command: 'my',    description: 'My projects and dashboards' },
    { command: 'hub',   description: 'Hub status' },
    { command: 'help',  description: 'Help' },
    { command: 'start', description: 'Start' },
  ];
  await tg(token, 'setMyCommands', { commands: common, scope: { type: 'all_private_chats' } }).catch(() => {});
  if (ownerChatId) {
    await tg(token, 'setMyCommands', {
      commands: [...common,
        { command: 'signin', description: 'Server root signin link' },
        { command: 'id',     description: 'Your Telegram chat ID' },
      ],
      scope: { type: 'chat', chat_id: Number(ownerChatId) },
    }).catch(() => {});
  }
}

// —— polling ——

async function startPolling(token) {
  _polling = true;
  const log = _ctx.logger.child('master-bot');
  while (_polling) {
    try {
      const r = await tg(token, 'getUpdates', {
        offset: _offset, timeout: 25,
        allowed_updates: ['message','callback_query'],
      });
      if (r.ok && r.result?.length) {
        for (const upd of r.result) {
          _offset = upd.update_id + 1;
          try { await dispatch(token, upd); } catch (e) { log.error('dispatch:', e.message); }
        }
      }
    } catch (e) {
      log.error('polling error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// —— dispatch ——

async function dispatch(token, upd) {
  // Callback queries from inline buttons — just acknowledge
  if (upd.callback_query) {
    await answerCallback(token, upd.callback_query.id);
    return;
  }

  const msg = upd.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const parts  = msg.text.trim().split(/\s+/);
  const cmd    = parts[0].replace(/@.*$/, '').toLowerCase();
  const args   = parts.slice(1).join(' ');

  if (cmd === '/id')    return send(token, chatId, `Your chat ID: <code>${chatId}</code>`);
  if (cmd === '/claim') {
    const sap = readSAP();
    if (!sap) return send(token, chatId, 'SAP not configured.');
    if (args.trim() === sap) { saveOwner(chatId); return send(token, chatId, '\u2713 You are now the owner of this Hub server.'); }
    return send(token, chatId, 'Wrong token.');
  }

  if (!_ownerChatId && cmd === '/start') { saveOwner(chatId); return handleStart(token, chatId, true); }

  const owner = isOwner(chatId);

  switch (cmd) {
    case '/new':    return handleNew(token, chatId, args);
    case '/my':     return handleMy(token, chatId, owner);
    case '/hub':    return handleHub(token, chatId, owner);
    case '/help':   return handleHelp(token, chatId, owner);
    case '/start':  return handleStart(token, chatId, owner);
    case '/signin': return owner ? handleSignin(token, chatId) : send(token, chatId, 'Unknown command. Send /help for the list.');
    default:        return send(token, chatId, 'Unknown command. Send /help for the list.');
  }
}

// —— handlers ——

async function handleStart(token, chatId, owner) {
  const base = _ctx.config.publicBase;
  if (!owner) {
    return send(token, chatId,
      `<b>Hub</b> \u2014 connect everything. Manage from chat.\n\n`+
      `Hub lets you run bots, sites, apps and APIs \u2014 all from one place.\n\n`+
      `/new \u2014 create a project\n/hub \u2014 hub status\n/help \u2014 help`,
      { reply_markup: kbd([{ text: 'hub.labs.co', url: base }]) }
    );
  }
  const state = _ctx.modules.drafts?.getState() || { projects: [] };
  const count = state.projects.length;
  const bots  = state.projects.filter(p => p.bot?.token).length;
  return send(token, chatId,
    `<b>Hub</b> \u2014 running.\n\n`+
    `<b>${count}</b> project${count!==1?'s':''} \u00b7 <b>${bots}</b> bot${bots!==1?'s':''} active\n`+
    `Server: <code>${base}</code>\n\n`+
    `/my \u2014 projects + dashboards\n/hub \u2014 hub status`
  );
}

async function handleNew(token, chatId, args) {
  const name = args.trim().toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,40);
  if (!name) return send(token, chatId,
    'Usage: /new projectname\n\nName: lowercase letters, numbers, hyphens, underscores.');
  try {
    const sap  = readSAP();
    const res  = await fetch('http://localhost:3100/drafts/projects', {
      method: 'POST',
      headers: {'Authorization':'Bearer '+sap,'Content-Type':'application/json'},
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.ok) {
      const papSecret = data.pap_activation_url?.split('_project_')[1];
      const base = _ctx.config.publicBase;
      const sn   = _ctx.config.serverNumber;
      const dashUrl = papSecret ? `${base}/signin/pass_${sn}_project_${papSecret}` : data.pap_activation_url;
      return send(token, chatId,
        `<b>${name}</b> created.\n\nLive: <a href="${data.live_url}">${data.live_url}</a>`,
        {
          reply_markup: kbd([
            [{ text: '\u25b6 Open live', url: data.live_url }, { text: '\u2699 Dashboard', url: dashUrl }],
          ]),
        }
      );
    }
    return send(token, chatId, `Failed: ${data.error}`);
  } catch (e) { return send(token, chatId, `Error: ${e.message}`); }
}

async function handleMy(token, chatId, owner) {
  const state = _ctx.modules.drafts?.getState() || { projects: [] };
  const base  = _ctx.config.publicBase;
  const sn    = _ctx.config.serverNumber;
  const sap   = readSAP();

  if (!state.projects.length) {
    return send(token, chatId, owner ? 'No projects yet. Use /new name to create one.' : 'No projects on this server yet.');
  }

  // Build button rows
  const buttons = [];

  // Owner: server dashboard button first
  if (owner && sap) {
    buttons.push({ text: '\u2609 Hub Server dashboard', url: `${base}/signin/pass_${sn}_server_${sap}` });
  }

  // One row per project: [Live] [Dashboard]
  for (const p of state.projects) {
    const papSecret = p.pap?.token?.replace(/^pap_/,'');
    const dashUrl   = papSecret ? `${base}/signin/pass_${sn}_project_${papSecret}` : null;
    const liveUrl   = `${base}/${p.name}/`;
    const label     = p.description || p.name;
    const botTag    = p.bot?.token ? ` \u00b7 @${p.bot.bot_username}` : '';

    const row = [{ text: `\u25b6 ${label}${botTag}`, url: liveUrl }];
    if (dashUrl && owner) row.push({ text: '\u2699 dashboard', url: dashUrl });
    buttons.push(row);
  }

  const count = state.projects.length;
  const bots  = state.projects.filter(p => p.bot?.token).length;

  return send(token, chatId,
    `<b>${count} project${count!==1?'s':''}</b> \u00b7 ${bots} bot${bots!==1?'s':''} active`,
    { reply_markup: kbd(buttons) }
  );
}

async function handleHub(token, chatId, owner) {
  try {
    const r     = await fetch('http://localhost:3100/health');
    const h     = await r.json();
    const state = _ctx.modules.drafts?.getState() || { projects: [] };
    const bots  = state.projects.filter(p => p.bot?.token).length;
    const upMin = Math.floor(h.uptime_sec/60);
    const base  = _ctx.config.publicBase;
    const sn    = _ctx.config.serverNumber;
    const sap   = readSAP();

    const text = `<b>Hub ${h.version}</b> \u2014 ${h.ok?'online':'degraded'}\n\n`+
      `Modules: ${h.modules.join(', ')}\n`+
      `Projects: ${state.projects.length} \u00b7 Bots: ${bots}\n`+
      `Uptime: ${upMin}m\n`+
      `Server: ${base}`;

    const buttons = [];
    if (owner && sap) {
      // Inline buttons for owner: server dashboard + all project dashboards
      buttons.push({ text: '\u2609 Server dashboard', url: `${base}/signin/pass_${sn}_server_${sap}` });
      for (const p of state.projects) {
        const papSecret = p.pap?.token?.replace(/^pap_/,'');
        if (papSecret) {
          const label = p.description || p.name;
          const botTag = p.bot?.token ? ` @${p.bot.bot_username}` : '';
          buttons.push({ text: `\u2699 ${label}${botTag}`, url: `${base}/signin/pass_${sn}_project_${papSecret}` });
        }
      }
    } else {
      buttons.push({ text: 'hub.labs.co', url: base });
    }

    return send(token, chatId, text, { reply_markup: kbd(buttons) });
  } catch (e) { return send(token, chatId, `Health check failed: ${e.message}`); }
}

async function handleHelp(token, chatId, owner) {
  let text = `<b>Hub commands</b>\n\n`+
    `/new name \u2014 create a project\n`+
    `/my \u2014 my projects and dashboards\n`+
    `/hub \u2014 hub status\n`+
    `/help \u2014 this list\n`+
    `/start \u2014 start`;
  if (owner) text += `\n\n<b>Owner only</b>\n/signin \u2014 server root link\n/id \u2014 your chat ID`;
  return send(token, chatId, text);
}

async function handleSignin(token, chatId) {
  const sap  = readSAP();
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  const url  = `${base}/signin/pass_${sn}_server_${sap}`;
  return send(token, chatId,
    `Server dashboard:\n\n<i>Full server access. Don't share.</i>`,
    { reply_markup: kbd([{ text: '\u2609 Open server dashboard', url }]) }
  );
}

// —— module contract ——

export function getTelegramStatus() {
  return { installed: !!loadToken(), bot: _botInfo||null, polling: _polling };
}

export async function init(ctx) {
  _ctx = ctx;
  _ownerChatId = loadOwner();
  const token = loadToken();
  if (!token) { ctx.logger.info('[master-bot] no token found, skipping'); return; }
  const me = await tg(token, 'getMe');
  if (!me.ok) { ctx.logger.warn('[master-bot] getMe failed:', me.description); return; }
  _botInfo = me.result;
  ctx.logger.info('[master-bot] connected as @'+_botInfo.username+
    (_ownerChatId ? ` (owner: ${_ownerChatId})` : ' (no owner — first /start claims)'));
  await setCommands(token, _ownerChatId);
  startPolling(token).catch(e => ctx.logger.error('[master-bot] polling crashed:', e.message));
}

export function mountRoutes(app, ctx) {}
