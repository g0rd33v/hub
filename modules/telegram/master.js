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
const wizUrl   = tgId  => `${_ctx.config.publicBase}/hub/wizard?tg=${encodeURIComponent(tgId || '')}`;
const kbd      = btns  => ({ inline_keyboard: btns.map(b => Array.isArray(b) ? b : [b]) });

// Buffer helpers — delegate to modules/buffer
const bufAdd   = (userId, text, kind)  => _ctx.modules.buffer?.bufferAdd?.(_ctx.config.dataDir, userId, text, kind);
const bufList  = (userId, n)           => _ctx.modules.buffer?.bufferList?.(_ctx.config.dataDir, userId, n) || [];
const bufCount = (userId)              => _ctx.modules.buffer?.bufferCount?.(_ctx.config.dataDir, userId) || 0;
const bufClear = (userId)              => _ctx.modules.buffer?.bufferClear?.(_ctx.config.dataDir, userId);

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
    { command: 'start',  description: 'Welcome to Hub' },
    { command: 'new',    description: 'Connect anything' },
    { command: 'my',     description: 'My projects' },
    { command: 'buffer', description: 'My buffer' },
    { command: 'hub',    description: 'Hub status' },
    { command: 'help',   description: 'All commands' },
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

const PATTERNS = [
  { id: 'wizard_payload',     re: /^\{.*"hub_wizard"\s*:\s*true.*\}$/s },
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
  for (const p of PATTERNS) if (p.re.test(t)) return { type: p.id, value: t };
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

  // Owner-only
  if (cmd === '/id') return send(token, chatId, `Your ID: <code>${chatId}</code>`);
  if (cmd === '/claim') {
    const sap = readSAP();
    if (!sap) return send(token, chatId, 'SAP not configured.');
    if (args === sap) { saveOwner(chatId); return send(token, chatId, '\u2713 You are now the server owner.'); }
    return send(token, chatId, 'Wrong token.');
  }
  if (!_ownerChatId && cmd === '/start') { saveOwner(chatId); return handleStart(token, chatId, true); }

  const owner = isOwner(chatId);

  switch (cmd) {
    case '/start':  return handleStart(token, chatId, owner);
    case '/new':    return handleNew(token, chatId, args || null, chatId);
    case '/my':     return handleMy(token, chatId, owner);
    case '/buffer': return handleBuffer(token, chatId, args);
    case '/hub':    return handleHub(token, chatId, owner);
    case '/help':   return handleHelp(token, chatId, owner);
    case '/signin': return owner ? handleSignin(token, chatId) : send(token, chatId, 'Unknown command. /help for the list.');
  }

  // Any non-command message goes through intake
  // AND is saved to the user's personal buffer
  if (!cmd.startsWith('/')) {
    // Auto-save to buffer (silent, non-blocking)
    bufAdd(chatId, raw, 'text');
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

// handleNew — three entry points
async function handleNew(token, chatId, hint, userId) {
  if (hint) return handleIntake(token, chatId, hint, isOwner(chatId));

  return send(token, chatId,
    `<b>Connect or create anything.</b>\n\n`+
    `Three ways to start:\n\n`+
    `<b>1.</b> Just send me what you have \u2014 I\'ll figure it out.\n`+
    `<i>Bot token, API key, project name, URL, pass link.</i>\n\n`+
    `<b>2.</b> Describe what you want to build \u2014 I\'ll generate a project plan.\n`+
    `<i>Example: \u201ca daily crypto price bot with AI summaries\u201d</i>\n\n`+
    `<b>3.</b> Open the Wizard \u2014 fill in the form, copy the result, send it here.`,
    { reply_markup: kbd([
        [{ text: '\u2728 Open Wizard', web_app: { url: wizUrl(userId || chatId) } }],
    ]) }
  );
}

// ── Buffer handler ───────────────────────────────────────────────────────────

async function handleBuffer(token, chatId, args) {
  const base  = _ctx.config.publicBase;
  const userId = String(chatId);

  // /buffer clear
  if (args === 'clear') {
    bufClear(userId);
    return send(token, chatId, '\u2713 Buffer cleared.');
  }

  const entries = bufList(userId, 10);
  const total   = bufCount(userId);
  const feedUrl = `${base}/buffer/${userId}`;

  if (!total) {
    return send(token, chatId,
      `<b>Your buffer is empty.</b>\n\n`+
      `Everything you send to this bot (that isn\'t a command) is automatically saved here.\n\n`+
      `Try sending a link, a thought, a note \u2014 anything.`
    );
  }

  // Format recent entries
  const lines = entries.slice(0, 5).map((e, i) => {
    const preview = e.text.length > 80 ? e.text.slice(0, 77) + '\u2026' : e.text;
    const age     = timeAgo(e.ts);
    return `${i + 1}. <i>${age}</i>\n${escHtml(preview)}`;
  }).join('\n\n');

  const moreText = total > 5 ? `\n\n<i>+${total - 5} more. Full feed below.</i>` : '';

  return send(token, chatId,
    `<b>Buffer</b> \u2014 ${total} item${total !== 1 ? 's' : ''}\n\n${lines}${moreText}`,
    { reply_markup: kbd([
        [{ text: '\u{1F517} Buffer feed (JSON)', url: feedUrl }],
        [{ text: '\u{1F5D1} Clear buffer', callback_data: 'buffer_clear' }],
    ]) }
  );
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000)    return `${Math.floor(d/1000)}s ago`;
  if (d < 3600000)  return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return `${Math.floor(d/86400000)}d ago`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Intake: universal smart router ───────────────────────────────────────────

async function handleIntake(token, chatId, text, owner) {
  const { type, value } = recognise(text);
  const sn  = _ctx.config.serverNumber;
  const sap = readSAP();

  switch (type) {

    // ── Wizard payload (JSON from Wizard webapp)
    case 'wizard_payload': {
      let plan;
      try { plan = JSON.parse(value); } catch { return send(token, chatId, '\u274c Invalid wizard payload.'); }
      await send(token, chatId, `\u23f3 Creating project <b>${escHtml(plan.name)}</b>\u2026`);
      return createProjectFromPlan(token, chatId, plan, sn, sap);
    }

    // ── Telegram bot token
    case 'telegram_bot_token': {
      let botInfo;
      try {
        const r = await tg(value, 'getMe');
        if (!r.ok) return send(token, chatId, `\u274c Not a valid bot token.\n\n<i>${r.description}</i>`);
        botInfo = r.result;
      } catch (e) { return send(token, chatId, `\u274c Could not validate: ${e.message}`); }
      const state      = _ctx.modules.drafts?.getState() || { projects: [] };
      const withoutBot = state.projects.filter(p => !p.bot?.token);
      if (withoutBot.length === 1) return attachBotToProject(token, chatId, withoutBot[0], value, botInfo, sn);
      if (withoutBot.length === 0) {
        return send(token, chatId, `\u2705 Valid bot: <b>@${botInfo.username}</b>\n\nAll projects already have bots. Send a project name to create a new one.`);
      }
      const buttons = withoutBot.slice(0, 8).map(p => ({ text: `\u2295 ${p.description || p.name}`, callback_data: `attach:${p.name}` }));
      return send(token, chatId, `\u2705 Valid bot: <b>@${botInfo.username}</b>\n\nWhich project?`, { reply_markup: kbd(buttons) });
    }

    // ── SAP pass
    case 'pass_sap': {
      return send(token, chatId, `\u2609 Server dashboard`,
        { reply_markup: kbd([[{ text: '\u2609 Open dashboard', web_app: { url: waUrl(value) } }]]) });
    }

    // ── PAP pass
    case 'pass_pap': {
      let passToken = value;
      if (value.startsWith('pap_')) passToken = `pass_${sn}_project_${value.replace(/^pap_/, '')}`;
      return send(token, chatId, `\u2699 Project dashboard`,
        { reply_markup: kbd([[{ text: '\u2699 Open dashboard', web_app: { url: waUrl(passToken) } }]]) });
    }

    // ── API keys
    case 'openrouter_key':
    case 'openai_key':
    case 'anthropic_key': {
      const labels  = { openrouter_key: 'OpenRouter', openai_key: 'OpenAI', anthropic_key: 'Anthropic' };
      const envKeys = { openrouter_key: 'OPENROUTER_API_KEY', openai_key: 'OPENAI_API_KEY', anthropic_key: 'ANTHROPIC_API_KEY' };
      try {
        fs.writeFileSync(`/etc/hub/${envKeys[type]}`, value + '\n', { mode: 0o600 });
        return send(token, chatId, `\u2705 <b>${labels[type]} key saved.</b>\n\n<code>/etc/hub/${envKeys[type]}</code>`);
      } catch (e) { return send(token, chatId, `\u274c Failed: ${e.message}`); }
    }

    // ── URL
    case 'url': {
      const state   = _ctx.modules.drafts?.getState() || { projects: [] };
      const withBot = state.projects.filter(p => p.bot?.token);
      if (!withBot.length) return send(token, chatId, `\u2705 URL saved to buffer.\n\nNo bots connected yet. Create a project first.`);
      if (withBot.length === 1) return setWebhookForProject(token, chatId, withBot[0], value);
      const buttons = withBot.slice(0, 8).map(p => ({ text: `\u2295 @${p.bot.bot_username}`, callback_data: `webhook:${p.name}` }));
      return send(token, chatId, `\u2705 URL: <code>${escHtml(value)}</code>\n\nSet as webhook for which bot?`, { reply_markup: kbd(buttons) });
    }

    // ── Project name
    case 'project_name': return createProject(token, chatId, value, sn, sap);

    // ── Unknown — sentence? try LLM plan
    default: {
      if (value.includes(' ') && value.length > 8) return handlePromptPlan(token, chatId, value, sn, sap);
      return send(token, chatId,
        `Not sure what <code>${escHtml(value.slice(0,40))}</code> is.\n\n`+
        `I understand: bot token, project name, API key, URL, pass link, or a description of what to build.\n\nOr open the Wizard:`,
        { reply_markup: kbd([[{ text: '\u2728 Open Wizard', web_app: { url: wizUrl(chatId) } }]]) }
      );
    }
  }
}

// handlePromptPlan — free-text description → AI plan
async function handlePromptPlan(token, chatId, prompt, sn, sap) {
  await send(token, chatId, `\u23f3 Generating project plan\u2026`);
  try {
    const r    = await fetch('http://localhost:3100/hub/api/wizard/generate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sap}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await r.json();
    if (!data.ok || !data.plan) throw new Error(data.error || 'no plan');
    const plan  = data.plan;
    const needs = plan.needs || [];
    const needLabels = {
      bot_token:'\u2295 Bot token (from @BotFather)',
      openrouter_key:'\u2295 OpenRouter key',
      openai_key:'\u2295 OpenAI key',
      anthropic_key:'\u2295 Anthropic key',
      webhook_url:'\u2295 Webhook URL',
    };
    const needsList = needs.map(n => needLabels[n] || '\u2295 '+n).join('\n');
    const text =
      `\u2728 <b>Project plan</b>\n\n`+
      `<b>${escHtml(plan.name)}</b> \u2014 ${escHtml(plan.description)}\n`+
      `Type: ${plan.type} \u00b7 Stack: ${escHtml(plan.stack||'')}\n\n`+
      (plan.description_long ? `${escHtml(plan.description_long)}\n\n` : '')+
      (needsList ? `<b>You\'ll need:</b>\n${needsList}\n\n` : '')+
      `Create this project?`;
    return send(token, chatId, text, { reply_markup: kbd([
        [{ text: `\u2713 Create ${escHtml(plan.name)}`, callback_data: `create_plan:${plan.name}:${encodeURIComponent(plan.description)}` }],
        [{ text: '\u2728 Open Wizard instead', web_app: { url: wizUrl(chatId) } }],
    ]) });
  } catch (e) {
    return send(token, chatId,
      `Couldn\'t generate a plan: ${e.message}\n\nTry the Wizard:`,
      { reply_markup: kbd([[{ text: '\u2728 Open Wizard', web_app: { url: wizUrl(chatId) } }]]) }
    );
  }
}

// ── Intake actions ───────────────────────────────────────────────────────────

async function createProjectFromPlan(token, chatId, plan, sn, sap) {
  // Create the project
  try {
    const res  = await fetch('http://localhost:3100/drafts/projects', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sap}`, 'Content-Type': 'application/json' },
      body:   JSON.stringify({ name: plan.name, description: plan.description }),
    });
    const data = await res.json();
    if (!data.ok) return send(token, chatId, `\u274c Failed to create project: ${data.error}`);

    const papSecret = (data.pap_token || '').replace(/^pap_/, '');
    const dashPass  = papSecret ? `pass_${sn}_project_${papSecret}` : null;
    const needs     = plan.needs || [];
    const base      = _ctx.config.publicBase;

    const needLabels = {
      bot_token:      'Bot token \u2014 send @BotFather token here',
      openrouter_key: 'OpenRouter key \u2014 send sk-or-v1-... here',
      openai_key:     'OpenAI key \u2014 send sk-... here',
      anthropic_key:  'Anthropic key \u2014 send sk-ant-... here',
      webhook_url:    'Webhook URL \u2014 send https://... here',
    };
    const needLines = needs.length
      ? '\n\n<b>Now send me:</b>\n' + needs.map(n => '\u2295 ' + (needLabels[n] || n)).join('\n')
      : '';

    return send(token, chatId,
      `\u2705 <b>${escHtml(plan.name)}</b> created.\n\n`+
      `<a href="${data.live_url}">${data.live_url}</a>${needLines}`,
      { reply_markup: dashPass ? kbd([[
          { text: '\u25b6 Open', url: data.live_url },
          { text: '\u2699 Dashboard', web_app: { url: waUrl(dashPass) } },
      ]]) : undefined }
    );
  } catch (e) { return send(token, chatId, `\u274c Error: ${e.message}`); }
}

async function createProject(token, chatId, name, sn, sap) {
  try {
    const res  = await fetch('http://localhost:3100/drafts/projects', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sap}`, 'Content-Type': 'application/json' },
      body:   JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!data.ok) return send(token, chatId, `\u274c Failed: ${data.error}`);
    const papSecret = (data.pap_token || '').replace(/^pap_/, '');
    const dashPass  = papSecret ? `pass_${sn}_project_${papSecret}` : null;
    return send(token, chatId,
      `\u2705 <b>${escHtml(name)}</b> created.\n\n<a href="${data.live_url}">${data.live_url}</a>`,
      { reply_markup: kbd([[
          { text: '\u25b6 Open', url: data.live_url },
          dashPass ? { text: '\u2699 Dashboard', web_app: { url: waUrl(dashPass) } } : { text: '\u2699 Dashboard', url: data.pap_activation_url },
      ]]) });
  } catch (e) { return send(token, chatId, `\u274c Error: ${e.message}`); }
}

async function attachBotToProject(token, chatId, project, botToken, botInfo, sn) {
  try {
    const papToken = project.pap?.token;
    if (!papToken) return send(token, chatId, `\u274c Project ${project.name} has no PAP token.`);
    const r    = await fetch('http://localhost:3100/drafts/project/bot', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${papToken}`, 'Content-Type': 'application/json' },
      body:   JSON.stringify({ token: botToken }),
    });
    const data = await r.json();
    if (!data.ok) return send(token, chatId, `\u274c Failed: ${data.error || data.detail}`);
    const papSecret = papToken.replace(/^pap_/, '');
    return send(token, chatId,
      `\u2705 <b>@${botInfo.username}</b> linked to <b>${escHtml(project.description || project.name)}</b>.`,
      { reply_markup: kbd([[{ text: '\u2699 Dashboard', web_app: { url: waUrl(`pass_${sn}_project_${papSecret}`) } }]]) });
  } catch (e) { return send(token, chatId, `\u274c Error: ${e.message}`); }
}

async function setWebhookForProject(token, chatId, project, url) {
  try {
    const papToken = project.pap?.token;
    if (!papToken) return send(token, chatId, `\u274c No PAP token for ${project.name}.`);
    const r    = await fetch('http://localhost:3100/drafts/project/bot/webhook', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${papToken}`, 'Content-Type': 'application/json' },
      body:   JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!data.ok) return send(token, chatId, `\u274c Failed: ${data.error || data.detail}`);
    return send(token, chatId, `\u2705 Webhook set for <b>@${project.bot.bot_username}</b>.\n\n<code>${escHtml(url)}</code>`);
  } catch (e) { return send(token, chatId, `\u274c Error: ${e.message}`); }
}

// ── Other handlers ───────────────────────────────────────────────────────────

async function handleMy(token, chatId, owner) {
  const state = _ctx.modules.drafts?.getState() || { projects: [] };
  const base  = _ctx.config.publicBase;
  const sn    = _ctx.config.serverNumber;
  const sap   = readSAP();
  if (!state.projects.length) return send(token, chatId, 'No projects yet. /new to create one.');
  const buttons = [];
  if (owner && sap) buttons.push({ text: '\u2609 Hub Server', web_app: { url: waUrl(`pass_${sn}_server_${sap}`) } });
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
    `<b>${count} project${count!==1?'s':''}</b> \u00b7 ${bots} bot${bots!==1?'s':''} active`,
    { reply_markup: kbd(buttons) });
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
    const text  =
      `<b>Hub ${h.version}</b> \u2014 ${h.ok ? 'online' : 'degraded'}\n`+
      `Projects: ${state.projects.length} \u00b7 Bots: ${bots}\n`+
      `Uptime: ${Math.floor(h.uptime_sec/60)}m \u00b7 ${base}`;
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
  } catch (e) { return send(token, chatId, `Error: ${e.message}`); }
}

async function handleHelp(token, chatId, owner) {
  let text =
    `/start \u2014 welcome\n`+
    `/new \u2014 connect or create anything\n`+
    `/my \u2014 my projects\n`+
    `/buffer \u2014 my buffer\n`+
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
    ]) });
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
