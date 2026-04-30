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

// ── Helpers ────────────────────────────────────────────────────────────────

const tokenPath = () => _ctx.paths.masterBotToken();
const ownerPath = () => path.join(_ctx.config.configDir, 'owner.id');

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
  try {
    const p = ownerPath();
    if (fs.existsSync(p)) { const r = fs.readFileSync(p, 'utf8').trim(); if (r) return String(r); }
  } catch {}
  return null;
}

function saveOwner(chatId) {
  _ownerChatId = String(chatId);
  try {
    fs.mkdirSync(path.dirname(ownerPath()), { recursive: true });
    fs.writeFileSync(ownerPath(), _ownerChatId + '\n', { mode: 0o600 });
    _ctx.logger.info('[master-bot] owner set to', _ownerChatId);
  } catch (e) { _ctx.logger.error('[master-bot] failed to save owner:', e.message); }
}

const isOwner  = chatId => !!_ownerChatId && String(chatId) === _ownerChatId;
const readSAP  = () => { try { return fs.readFileSync('/etc/hub/sap.token', 'utf8').trim(); } catch { return ''; } };
const waUrl    = pass  => `${_ctx.config.publicBase}/hub/webapp?token=${encodeURIComponent(pass)}`;
const kbd      = btns  => ({ inline_keyboard: btns.map(b => Array.isArray(b) ? b : [b]) });

async function tg(token, method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  return r.json();
}

const send = (token, chatId, text, extra = {}) =>
  tg(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

const answerCb = (token, id) => tg(token, 'answerCallbackQuery', { callback_query_id: id });

// ── Commands ───────────────────────────────────────────────────────────────

async function setCommands(token, ownerChatId) {
  const common = [
    { command: 'start', description: 'Welcome to Hub' },
    { command: 'new',   description: 'Connect anything' },
    { command: 'my',    description: 'My projects' },
    { command: 'hub',   description: 'Hub status' },
    { command: 'help',  description: 'All commands' },
  ];
  await tg(token, 'setMyCommands', { commands: common, scope: { type: 'all_private_chats' } }).catch(() => {});
  if (ownerChatId) {
    await tg(token, 'setMyCommands', {
      commands: [...common,
        { command: 'signin', description: 'Server access' },
        { command: 'id',     description: 'Your ID' },
      ],
      scope: { type: 'chat', chat_id: Number(ownerChatId) },
    }).catch(() => {});
  }
}

// ── Intake: recognise what the user sent ───────────────────────────────────────
//
// Patterns matched (in order):
//  telegram_bot_token  — \d+:[A-Za-z0-9_-]{35,}
//  pass_sap            — pass_N_server_HEX
//  pass_pap            — pass_N_project_HEX  or  pap_HEX
//  openrouter_key      — sk-or-v1-...
//  openai_key          — sk-... (40+ chars)
//  anthropic_key       — sk-ant-...
//  url                 — https?://...
//  project_name        — [a-z][a-z0-9_-]{1,39} (slug-like)
//  unknown             — ask

const PATTERNS = [
  { id: 'telegram_bot_token', re: /^\d{5,15}:[A-Za-z0-9_-]{35,}$/ },
  { id: 'pass_sap',           re: /^pass_\d+_server_[0-9a-f]{8,}$/ },
  { id: 'pass_pap',           re: /^pass_\d+_project_[0-9a-f]{8,}$|^pap_[0-9a-f]{8,}$/ },
  { id: 'openrouter_key',     re: /^sk-or-v1-[A-Za-z0-9_-]{20,}$/ },
  { id: 'anthropic_key',      re: /^sk-ant-[A-Za-z0-9_-]{20,}$/ },
  { id: 'openai_key',         re: /^sk-[A-Za-z0-9_-]{40,}$/ },
  { id: 'url',                re: /^https?:\/\/.{4,}/ },
  { id: 'project_name',       re: /^[a-z][a-z0-9_-]{1,39}$/ },
];

function recognise(text) {
  const t = text.trim();
  for (const p of PATTERNS) {
    if (p.re.test(t)) return { type: p.id, value: t };
  }
  return { type: 'unknown', value: t };
}

// ── Polling ─────────────────────────────────────────────────────────────────

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
          try { await dispatch(token, upd); } catch (e) { log.error('dispatch:', e.message); }
        }
      }
    } catch (e) {
      log.error('polling error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

async function dispatch(token, upd) {
  if (upd.callback_query) { await answerCb(token, upd.callback_query.id); return; }
  const msg = upd.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const raw    = msg.text.trim();
  const parts  = raw.split(/\s+/);
  const cmd    = parts[0].replace(/@.*$/, '').toLowerCase();
  const args   = parts.slice(1).join(' ').trim();

  // Hard-coded owner commands
  if (cmd === '/id')    return send(token, chatId, `Your ID: <code>${chatId}</code>`);
  if (cmd === '/claim') {
    const sap = readSAP();
    if (!sap) return send(token, chatId, 'SAP not configured.');
    if (args === sap) { saveOwner(chatId); return send(token, chatId, '\u2713 You are now the server owner.'); }
    return send(token, chatId, 'Wrong token.');
  }
  if (!_ownerChatId && cmd === '/start') { saveOwner(chatId); return handleStart(token, chatId, true); }

  const owner = isOwner(chatId);

  // Named commands
  switch (cmd) {
    case '/start':  return handleStart(token, chatId, owner);
    case '/new':    return handleNew(token, chatId, args || null);
    case '/my':     return handleMy(token, chatId, owner);
    case '/hub':    return handleHub(token, chatId, owner);
    case '/help':   return handleHelp(token, chatId, owner);
    case '/signin': return owner ? handleSignin(token, chatId) : send(token, chatId, 'Unknown command. /help for the list.');
  }

  // Any message that isn’t a slash command — route through intake
  if (!cmd.startsWith('/')) {
    return handleIntake(token, chatId, raw, owner);
  }

  return send(token, chatId, 'Unknown command. /help for the list.');
}

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleStart(token, chatId, owner) {
  const base = _ctx.config.publicBase;
  if (!owner) {
    return send(token, chatId,
      `<b>Hub</b> \u2014 run bots, sites and APIs from one place.\n\n`+
      `/new \u2014 connect or create anything\n/hub \u2014 status\n/help \u2014 all commands`,
      { reply_markup: kbd([{ text: 'hub.labs.co', url: base }]) }
    );
  }
  const state = _ctx.modules.drafts?.getState() || { projects: [] };
  const count = state.projects.length;
  const bots  = state.projects.filter(p => p.bot?.token).length;
  return send(token, chatId,
    `<b>Hub</b> \u2014 running.\n\n`+
    `<b>${count}</b> project${count !== 1 ? 's' : ''} \u00b7 <b>${bots}</b> bot${bots !== 1 ? 's' : ''} active\n`+
    `Server: <code>${base}</code>`
  );
}

// handleNew — called with /new [optional hint]
// If hint provided: treat it as intake. If empty: show onboarding prompt.
async function handleNew(token, chatId, hint) {
  if (hint) return handleIntake(token, chatId, hint, isOwner(chatId));

  return send(token, chatId,
    `<b>Connect or create anything.</b>\n\n`+
    `Just send me what you have and I\u2019ll figure it out:\n\n`+
    `\u00b7 <b>Bot token</b> \u2014 connect a Telegram bot\n`+
    `\u00b7 <b>Project name</b> \u2014 create a new project\n`+
    `\u00b7 <b>API key</b> \u2014 OpenRouter, OpenAI, Anthropic\n`+
    `\u00b7 <b>URL</b> \u2014 set as webhook endpoint\n`+
    `\u00b7 <b>Pass link</b> \u2014 open a project dashboard\n\n`+
    `<i>Send it now \u2014 one message is enough.</i>`
  );
}

// handleIntake — universal smart router
async function handleIntake(token, chatId, text, owner) {
  const { type, value } = recognise(text);
  const sn  = _ctx.config.serverNumber;
  const sap = readSAP();

  switch (type) {

    // ── Telegram bot token — need to know which project to attach to
    case 'telegram_bot_token': {
      // Validate token first
      let botInfo;
      try {
        const r = await tg(value, 'getMe');
        if (!r.ok) return send(token, chatId, `\u274c That doesn\u2019t look like a valid bot token.\n\n<i>${r.description}</i>`);
        botInfo = r.result;
      } catch (e) {
        return send(token, chatId, `\u274c Could not validate token: ${e.message}`);
      }

      // Check if there\u2019s only one project — attach automatically
      const state = _ctx.modules.drafts?.getState() || { projects: [] };
      const projsWithoutBot = state.projects.filter(p => !p.bot?.token);

      if (projsWithoutBot.length === 1) {
        // Auto-attach
        return attachBotToProject(token, chatId, projsWithoutBot[0], value, botInfo, sn);
      }

      if (projsWithoutBot.length === 0) {
        // All projects have bots — ask if they want to create a new project
        return send(token, chatId,
          `\u2705 Valid bot: <b>@${botInfo.username}</b>\n\n`+
          `All your projects already have bots. Send a project name to create a new one, then I\u2019ll attach this bot.`
        );
      }

      // Multiple projects without bots — show picker
      const buttons = projsWithoutBot.slice(0, 8).map(p => ({
        text: `\u2295 ${p.description || p.name}`, callback_data: `attach_bot:${p.name}:${value}`,
      }));
      return send(token, chatId,
        `\u2705 Valid bot: <b>@${botInfo.username}</b>\n\nWhich project should I attach it to?`,
        { reply_markup: kbd(buttons) }
      );
    }

    // ── SAP pass — open server dashboard
    case 'pass_sap': {
      const url = waUrl(value);
      return send(token, chatId,
        `\u2609 Server dashboard`,
        { reply_markup: kbd([[{ text: '\u2609 Open dashboard', web_app: { url } }]]) }
      );
    }

    // ── PAP pass — open project dashboard
    case 'pass_pap': {
      // Normalise pap_ -> pass_ format for webapp
      let passToken = value;
      if (value.startsWith('pap_')) {
        const hex = value.replace(/^pap_/, '');
        passToken  = `pass_${sn}_project_${hex}`;
      }
      const url = waUrl(passToken);
      return send(token, chatId,
        `\u2699 Project dashboard`,
        { reply_markup: kbd([[{ text: '\u2699 Open dashboard', web_app: { url } }]]) }
      );
    }

    // ── API keys — save to server config
    case 'openrouter_key':
    case 'openai_key':
    case 'anthropic_key': {
      const labels = {
        openrouter_key: 'OpenRouter',
        openai_key:     'OpenAI',
        anthropic_key:  'Anthropic',
      };
      const label  = labels[type];
      const envKey = {
        openrouter_key: 'OPENROUTER_API_KEY',
        openai_key:     'OPENAI_API_KEY',
        anthropic_key:  'ANTHROPIC_API_KEY',
      }[type];

      // Save to /etc/hub/{envKey}
      try {
        fs.writeFileSync(`/etc/hub/${envKey}`, value + '\n', { mode: 0o600 });
        return send(token, chatId,
          `\u2705 <b>${label} key saved.</b>\n\n`+
          `Stored at <code>/etc/hub/${envKey}</code>.\n`+
          `Projects can now use <code>process.env.${envKey}</code>.`
        );
      } catch (e) {
        return send(token, chatId, `\u274c Failed to save key: ${e.message}`);
      }
    }

    // ── URL — ask what to do with it
    case 'url': {
      const state  = _ctx.modules.drafts?.getState() || { projects: [] };
      const withBot = state.projects.filter(p => p.bot?.token);

      if (!withBot.length) {
        return send(token, chatId,
          `\u2705 Got a URL: <code>${value}</code>\n\n`+
          `No bots connected yet. Create a project first with /new, then I can set this as a webhook.`
        );
      }

      if (withBot.length === 1) {
        // Auto-set webhook for the only bot project
        return setWebhookForProject(token, chatId, withBot[0], value);
      }

      // Multiple bot projects — ask which one
      const buttons = withBot.slice(0, 8).map(p => ({
        text: `\u2295 @${p.bot.bot_username}`, callback_data: `set_webhook:${p.name}:${value}`,
      }));
      return send(token, chatId,
        `\u2705 Got a URL: <code>${value}</code>\n\nSet as webhook for which bot?`,
        { reply_markup: kbd(buttons) }
      );
    }

    // ── Project name — create project
    case 'project_name': {
      return createProject(token, chatId, value, sn, sap);
    }

    // ── Unknown — ask
    default: {
      return send(token, chatId,
        `Hmm, I\'m not sure what this is.\n\n`+
        `I can handle:\n`+
        `\u00b7 Telegram bot token\n`+
        `\u00b7 Project name (letters, numbers, hyphens)\n`+
        `\u00b7 API key (OpenRouter, OpenAI, Anthropic)\n`+
        `\u00b7 Webhook URL\n`+
        `\u00b7 Hub pass link\n\n`+
        `What is <code>${value.slice(0, 40)}</code>?`
      );
    }
  }
}

// ── Helpers for intake actions ─────────────────────────────────────────────

async function createProject(token, chatId, name, sn, sap) {
  try {
    const res  = await fetch('http://localhost:3100/drafts/projects', {
      method:  'POST',
      headers: { Authorization: `Bearer ${sap}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!data.ok) return send(token, chatId, `\u274c Failed: ${data.error}`);
    const papSecret = (data.pap_token || '').replace(/^pap_/, '');
    const dashPass  = papSecret ? `pass_${sn}_project_${papSecret}` : null;
    const buttons   = [[
      { text: '\u25b6 Open', url: data.live_url },
      dashPass
        ? { text: '\u2699 Dashboard', web_app: { url: waUrl(dashPass) } }
        : { text: '\u2699 Dashboard', url: data.pap_activation_url },
    ]];
    return send(token, chatId,
      `\u2705 <b>${name}</b> created.\n\n<a href="${data.live_url}">${data.live_url}</a>`,
      { reply_markup: kbd(buttons) }
    );
  } catch (e) {
    return send(token, chatId, `\u274c Error: ${e.message}`);
  }
}

async function attachBotToProject(token, chatId, project, botToken, botInfo, sn) {
  try {
    const papToken = project.pap?.token;
    if (!papToken) return send(token, chatId, `\u274c Project ${project.name} has no PAP token.`);
    const r = await fetch('http://localhost:3100/drafts/project/bot', {
      method:  'PUT',
      headers: { Authorization: `Bearer ${papToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token: botToken }),
    });
    const data = await r.json();
    if (!data.ok) return send(token, chatId, `\u274c Failed to link bot: ${data.error || data.detail}`);
    const papSecret = papToken.replace(/^pap_/, '');
    const dashPass  = `pass_${sn}_project_${papSecret}`;
    return send(token, chatId,
      `\u2705 <b>@${botInfo.username}</b> linked to <b>${project.description || project.name}</b>.`,
      { reply_markup: kbd([[
          { text: '\u2699 Open dashboard', web_app: { url: waUrl(dashPass) } },
      ]]) }
    );
  } catch (e) {
    return send(token, chatId, `\u274c Error: ${e.message}`);
  }
}

async function setWebhookForProject(token, chatId, project, url) {
  try {
    const papToken = project.pap?.token;
    if (!papToken) return send(token, chatId, `\u274c No PAP token for ${project.name}.`);
    const r = await fetch('http://localhost:3100/drafts/project/bot/webhook', {
      method:  'PUT',
      headers: { Authorization: `Bearer ${papToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!data.ok) return send(token, chatId, `\u274c Failed: ${data.error || data.detail}`);
    return send(token, chatId,
      `\u2705 Webhook set for <b>@${project.bot.bot_username}</b>.\n\n<code>${url}</code>`
    );
  } catch (e) {
    return send(token, chatId, `\u274c Error: ${e.message}`);
  }
}

// ── Other handlers ────────────────────────────────────────────────────────────

async function handleMy(token, chatId, owner) {
  const state = _ctx.modules.drafts?.getState() || { projects: [] };
  const base  = _ctx.config.publicBase;
  const sn    = _ctx.config.serverNumber;
  const sap   = readSAP();

  if (!state.projects.length) {
    return send(token, chatId, 'No projects yet. /new to create one.');
  }

  const buttons = [];
  if (owner && sap) {
    buttons.push({ text: '\u2609 Hub Server', web_app: { url: waUrl(`pass_${sn}_server_${sap}`) } });
  }
  for (const p of state.projects) {
    const papSecret = p.pap?.token?.replace(/^pap_/, '');
    const liveUrl   = `${base}/${p.name}/`;
    const label     = p.description || p.name;
    const botTag    = p.bot?.token ? ` \u00b7 @${p.bot.bot_username}` : '';
    const row = [{ text: `\u25b6 ${label}${botTag}`, url: liveUrl }];
    if (papSecret) row.push({ text: '\u2699 dashboard', web_app: { url: waUrl(`pass_${sn}_project_${papSecret}`) } });
    buttons.push(row);
  }

  const count = state.projects.length;
  const bots  = state.projects.filter(p => p.bot?.token).length;
  return send(token, chatId,
    `<b>${count} project${count !== 1 ? 's' : ''}</b> \u00b7 ${bots} bot${bots !== 1 ? 's' : ''} active`,
    { reply_markup: kbd(buttons) }
  );
}

async function handleHub(token, chatId, owner) {
  try {
    const r     = await fetch('http://localhost:3100/health');
    const h     = await r.json();
    const state = _ctx.modules.drafts?.getState() || { projects: [] };
    const bots  = state.projects.filter(p => p.bot?.token).length;
    const base  = _ctx.config.publicBase;
    const sn    = _ctx.config.serverNumber;
    const sap   = readSAP();

    const text =
      `<b>Hub ${h.version}</b> \u2014 ${h.ok ? 'online' : 'degraded'}\n`+
      `Projects: ${state.projects.length} \u00b7 Bots: ${bots}\n`+
      `Uptime: ${Math.floor(h.uptime_sec / 60)}m \u00b7 ${base}`;

    const buttons = [];
    if (owner && sap) {
      buttons.push({ text: '\u2609 Server dashboard', web_app: { url: waUrl(`pass_${sn}_server_${sap}`) } });
      for (const p of state.projects) {
        const papSecret = p.pap?.token?.replace(/^pap_/, '');
        if (papSecret) {
          const label  = p.description || p.name;
          const botTag = p.bot?.token ? ` @${p.bot.bot_username}` : '';
          buttons.push({ text: `\u2699 ${label}${botTag}`, web_app: { url: waUrl(`pass_${sn}_project_${papSecret}`) } });
        }
      }
    } else {
      buttons.push({ text: 'hub.labs.co', url: base });
    }
    return send(token, chatId, text, { reply_markup: kbd(buttons) });
  } catch (e) {
    return send(token, chatId, `Error: ${e.message}`);
  }
}

async function handleHelp(token, chatId, owner) {
  let text =
    `/start \u2014 welcome\n`+
    `/new \u2014 connect or create anything\n`+
    `/my \u2014 my projects\n`+
    `/hub \u2014 server status\n`+
    `/help \u2014 this list`;
  if (owner) text += `\n\n<b>Owner</b>\n/signin \u2014 server access\n/id \u2014 your ID`;
  return send(token, chatId, text);
}

async function handleSignin(token, chatId) {
  const sap       = readSAP();
  const sn        = _ctx.config.serverNumber;
  const base      = _ctx.config.publicBase;
  const passToken = `pass_${sn}_server_${sap}`;
  return send(token, chatId,
    `<b>Server access</b>\n\n<i>Do not share.</i>`,
    { reply_markup: kbd([
        [{ text: '\u2609 Open in Telegram', web_app: { url: waUrl(passToken) } }],
        [{ text: '\u2609 Open in browser',  url: `${base}/signin/${passToken}` }],
    ]) }
  );
}

// ── Module contract ────────────────────────────────────────────────────────────

export const getTelegramStatus = () => ({ installed: !!loadToken(), bot: _botInfo || null, polling: _polling });

export async function init(ctx) {
  _ctx = ctx;
  _ownerChatId = loadOwner();
  const token = loadToken();
  if (!token) { ctx.logger.info('[master-bot] no token found, skipping'); return; }
  const me = await tg(token, 'getMe');
  if (!me.ok) { ctx.logger.warn('[master-bot] getMe failed:', me.description); return; }
  _botInfo = me.result;
  ctx.logger.info('[master-bot] connected as @' + _botInfo.username +
    (_ownerChatId ? ` (owner: ${_ownerChatId})` : ' (no owner — first /start claims)'));
  await setCommands(token, _ownerChatId);
  startPolling(token).catch(e => ctx.logger.error('[master-bot] polling crashed:', e.message));
}

export function mountRoutes(app, ctx) {}
