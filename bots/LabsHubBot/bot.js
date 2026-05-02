// /var/lib/hub/bots/LabsHubBot/bot.js
//
// Master-bot @LabsHubBot, ported to run inside its own Docker container
// on hub-bot-runner v0.5+. All state access goes through Hub's bridge
// HTTP API (see modules/bridge/index.js).
//
// Differences vs the old in-process master.js:
//   - All `_ctx.modules.X.Y()` calls become `await bridge.Y(...)` HTTP fetches
//   - Owner persistence uses bridge userKv (key 'owner_chat_id' on tg=0)
//     instead of /etc/hub/owner.id (container can't write outside its FS)
//   - SAP read goes through bridge 'getSAP' (not implemented as a separate
//     endpoint — instead the container has KV_TOKEN env which IS the bot's
//     own HMAC; for full SAP-bearing operations we forward as Bearer KV_TOKEN
//     and bridge resolves to the bot's project mode)
//   - Polling lives in runner.js (we just register handler via ctx.on)

const HUB_URL    = process.env.HUB_URL    || 'http://host.docker.internal:3100';
const KV_TOKEN   = process.env.KV_TOKEN;       // HMAC(SAP, `${botId}:${project}`)
const PROJECT    = process.env.PROJECT;        // "LabsHubBot" — used as scope
const BOT_ID     = process.env.HUB_BOT_ID;     // numeric id from `bots` table
const PUBLIC_BASE  = process.env.PUBLIC_BASE  || 'https://hub.labs.co';
const SERVER_NUM   = parseInt(process.env.SERVER_NUMBER || '0', 10);
const SAP_FALLBACK = process.env.SAP_TOKEN || null;  // injected by botctl when SAP-required ops needed

if (!KV_TOKEN || !PROJECT || !BOT_ID) {
  console.error('[master-bot] FATAL: missing KV_TOKEN/PROJECT/HUB_BOT_ID env');
  process.exit(1);
}

// ── Bridge HTTP client ──────────────────────────────────────────────────────────
async function bridgeFetch(method, pathSuffix, body, useSAP = false) {
  const tok = useSAP && SAP_FALLBACK ? SAP_FALLBACK : KV_TOKEN;
  const headers = {
    'Authorization':   `Bearer ${tok}`,
    'Content-Type':    'application/json',
    'x-hub-bot-id':    String(BOT_ID),
    'x-hub-project':   PROJECT,
  };
  const init = { method, headers };
  if (body !== undefined && body !== null) init.body = JSON.stringify(body);
  const r = await fetch(`${HUB_URL}/internal/bridge${pathSuffix}`, init);
  let data;
  try { data = await r.json(); } catch { data = { ok: false, error: `non-json status ${r.status}` }; }
  if (!r.ok || !data.ok) {
    const msg = data?.error || `${r.status}`;
    throw new Error(`bridge ${method} ${pathSuffix}: ${msg}`);
  }
  return data;
}

const bridge = {
  ping:           ()                => bridgeFetch('GET',  '/ping'),
  getState:       ()                => bridgeFetch('GET',  '/state').then(d => d.state),
  saveState:      (state)           => bridgeFetch('POST', '/state', { state }, true),
  bufferAdd:      (tg, text, kind)  => bridgeFetch('POST', '/buffer/add',   { tg, text, kind }),
  bufferList:     (tg, limit = 50)  => bridgeFetch('POST', '/buffer/list',  { tg, limit }).then(d => d.entries),
  bufferCount:    (tg)              => bridgeFetch('POST', '/buffer/count', { tg }).then(d => d.count),
  bufferClear:    (tg)              => bridgeFetch('POST', '/buffer/clear', { tg }).then(d => d.ok),
  userKvGet:      (tg, key)         => bridgeFetch('POST', '/userkv/get',   { tg, key }).then(d => d.value),
  userKvSet:      (tg, key, value)  => bridgeFetch('POST', '/userkv/set',   { tg, key, value }),
  findProjectByPAP:           (t)   => bridgeFetch('GET', `/findProjectByPAP/${encodeURIComponent(t)}`).then(d => d.project),
  findProjectAndAAPByAAPToken:(t)   => bridgeFetch('GET', `/findProjectAndAAPByAAPToken/${encodeURIComponent(t)}`).then(d => d.found),
};

// ── Helpers ─────────────────────────────────────────────────────────────────────────────
const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const kbd     = btns => ({ inline_keyboard: btns.map(b => Array.isArray(b) ? b : [b]) });
const waUrl   = pass => `${PUBLIC_BASE}/hub/webapp?token=${encodeURIComponent(pass)}`;
const wizUrl  = tgId => `${PUBLIC_BASE}/hub/wizard?tg=${encodeURIComponent(tgId || '')}`;
function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000)    return `${Math.floor(d/1000)}s ago`;
  if (d < 3600000)  return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return `${Math.floor(d/86400000)}d ago`;
}

// ── Owner state (persisted via bridge userKv on tg=0 special user) ──────────
let _ownerChatId = null;
const OWNER_TG = '0';
const OWNER_KEY = 'master_owner_chat_id';

async function loadOwner() {
  try {
    const v = await bridge.userKvGet(OWNER_TG, OWNER_KEY);
    if (v) _ownerChatId = String(v);
  } catch {}
}
async function saveOwner(chatId) {
  _ownerChatId = String(chatId);
  try { await bridge.userKvSet(OWNER_TG, OWNER_KEY, _ownerChatId); }
  catch (e) { console.error('[master-bot] failed to save owner:', e.message); }
  console.log('[master-bot] owner set to', _ownerChatId);
}
const isOwner = chatId => !!_ownerChatId && String(chatId) === _ownerChatId;

// ── Mode (stage/prod) state ─────────────────────────────────────────────────────
async function getMode(chatId)            { return (await bridge.userKvGet(String(chatId), 'mode')) || 'prod'; }
async function setMode(chatId, mode)      { await bridge.userKvSet(String(chatId), 'mode', mode); }

// ── Intake patterns ─────────────────────────────────────────────────────────────────
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

// ── setup() ────────────────────────────────────────────────────────────────────────────
export default async function setup(bot, ctx) {
  await bridge.ping().then(
    p => console.log('[master-bot] bridge OK, modules:', JSON.stringify(p.modules_available)),
    e => console.error('[master-bot] bridge FAILED:', e.message)
  );
  await loadOwner();
  console.log('[master-bot] owner =', _ownerChatId || '(none yet)');

  // Set Telegram commands
  try {
    const me = ctx.me();
    const common = [
      { command: 'start',  description: 'Welcome to Hub' },
      { command: 'new',    description: 'Connect anything' },
      { command: 'my',     description: 'My projects' },
      { command: 'buffer', description: 'My buffer' },
      { command: 'hub',    description: 'Hub status' },
      { command: 'help',   description: 'All commands' },
    ];
    await bot.call('setMyCommands', { commands: common, scope: { type: 'all_private_chats' } });
    if (_ownerChatId) {
      await bot.call('setMyCommands', {
        commands: [...common,
          { command: 'signin', description: 'Server access' },
          { command: 'id',     description: 'Your ID' },
        ],
        scope: { type: 'chat', chat_id: Number(_ownerChatId) },
      });
    }
    console.log('[master-bot] commands set, running as @' + me.username);
  } catch (e) {
    console.error('[master-bot] setMyCommands:', e.message);
  }

  ctx.on('message', async (msg) => {
    if (!msg?.text) return;
    try { await dispatchMessage(bot, msg); }
    catch (e) { console.error('[handler]', e.message, e.stack || ''); }
  });
  ctx.on('callback_query', async (cb) => {
    try { await dispatchCallback(bot, cb); }
    catch (e) { console.error('[callback]', e.message, e.stack || ''); }
  });
}

// ── Telegram helpers ──────────────────────────────────────────────────────────────────
const send = (bot, chatId, text, extra = {}) =>
  bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// ── Dispatch ───────────────────────────────────────────────────────────────────────
async function dispatchMessage(bot, msg) {
  const chatId = msg.chat.id;
  const raw    = msg.text.trim();
  const parts  = raw.split(/\s+/);
  const cmd    = parts[0].replace(/@.*$/, '').toLowerCase();
  const args   = parts.slice(1).join(' ').trim();

  if (cmd === '/id') return send(bot, chatId, `Your ID: <code>${chatId}</code>`);

  if (!_ownerChatId && cmd === '/start') {
    await saveOwner(chatId);
    return handleStart(bot, chatId, true);
  }

  const owner = isOwner(chatId);

  switch (cmd) {
    case '/start':  return handleStart(bot, chatId, owner);
    case '/new':    return handleNew(bot, chatId, args || null);
    case '/my':     return handleMy(bot, chatId, owner);
    case '/buffer': return handleBuffer(bot, chatId, args);
    case '/hub':    return handleHub(bot, chatId, owner);
    case '/help':   return handleHelp(bot, chatId, owner);
    case '/signin': return owner ? handleSignin(bot, chatId)
                                 : send(bot, chatId, 'Unknown command. /help for the list.');
  }

  if (!cmd.startsWith('/')) {
    try { await bridge.bufferAdd(String(chatId), raw, 'text'); } catch {}
    return handleIntake(bot, chatId, raw, owner);
  }

  return send(bot, chatId, 'Unknown command. /help for the list.');
}

async function dispatchCallback(bot, cb) {
  await bot.answerCallbackQuery(cb.id).catch(() => {});
  // (Old master.js doesn't really act on callback_data — buttons are mostly
  //  web_app/url. If we add interactive flows we expand here.)
}

// ── Handlers ────────────────────────────────────────────────────────────────────
async function handleStart(bot, chatId, owner) {
  if (!owner) {
    return send(bot, chatId,
      `<b>Hub</b> \u2014 run bots, sites and APIs from one place.\n\n`+
      `/new \u2014 connect or create anything\n/hub \u2014 status\n/help \u2014 all commands`,
      { reply_markup: kbd([{ text: 'hub.labs.co', url: PUBLIC_BASE }]) }
    );
  }
  let count = 0, bots = 0;
  try {
    const state = await bridge.getState();
    count = (state.projects || []).length;
    bots  = (state.projects || []).filter(p => p.bot?.token).length;
  } catch {}
  return send(bot, chatId,
    `<b>Hub</b> \u2014 running.\n\n`+
    `<b>${count}</b> project${count !== 1 ? 's' : ''} \u00b7 <b>${bots}</b> bot${bots !== 1 ? 's' : ''} active\n`+
    `Server: <code>${PUBLIC_BASE}</code>`
  );
}

async function handleNew(bot, chatId, hint) {
  if (hint) return handleIntake(bot, chatId, hint, isOwner(chatId));
  return send(bot, chatId,
    `<b>Connect or create anything.</b>\n\n`+
    `Three ways to start:\n\n`+
    `<b>1.</b> Just send me what you have \u2014 I'll figure it out.\n`+
    `<i>Bot token, API key, project name, URL, pass link.</i>\n\n`+
    `<b>2.</b> Describe what you want to build \u2014 I'll generate a project plan.\n`+
    `<i>Example: \u201ca daily crypto price bot with AI summaries\u201d</i>\n\n`+
    `<b>3.</b> Open the Wizard \u2014 fill in the form, copy the result, send it here.`,
    { reply_markup: kbd([[{ text: '\u2728 Open Wizard', web_app: { url: wizUrl(chatId) } }]]) }
  );
}

async function handleBuffer(bot, chatId, args) {
  const userId = String(chatId);
  if (args === 'clear') {
    try { await bridge.bufferClear(userId); } catch {}
    return send(bot, chatId, '\u2713 Buffer cleared.');
  }
  let entries = [], total = 0;
  try {
    entries = await bridge.bufferList(userId, 10);
    total   = await bridge.bufferCount(userId);
  } catch (e) {
    return send(bot, chatId, `\u26a0 Buffer unavailable: ${e.message}`);
  }
  if (!total) {
    return send(bot, chatId,
      `<b>Your buffer is empty.</b>\n\n`+
      `Everything you send here (not a command) is saved automatically.\n\n`+
      `Send a link, a note, anything.`
    );
  }
  const lines = entries.slice(0, 5).map((e, i) => {
    const preview = e.text.length > 80 ? e.text.slice(0, 77) + '\u2026' : e.text;
    return `${i + 1}. <i>${timeAgo(e.ts)}</i>\n${escHtml(preview)}`;
  }).join('\n\n');
  const moreText = total > 5 ? `\n\n<i>+${total - 5} more. Full feed below.</i>` : '';
  const waUrl2   = `${PUBLIC_BASE}/hub/buffer?tg=${userId}`;
  return send(bot, chatId,
    `<b>Buffer</b> \u2014 ${total} item${total !== 1 ? 's' : ''}\n\n${lines}${moreText}`,
    { reply_markup: kbd([[{ text: '\u{1F4CB} Open Buffer', web_app: { url: waUrl2 } }]]) }
  );
}

async function handleMy(bot, chatId, owner) {
  let state;
  try { state = await bridge.getState(); }
  catch (e) { return send(bot, chatId, `\u26a0 State unavailable: ${e.message}`); }
  const projects = state.projects || [];
  if (!projects.length) return send(bot, chatId, 'No projects yet. /new to create one.');

  const buttons = [];
  if (owner && SAP_FALLBACK) {
    buttons.push({ text: '\u2609 Hub Server', web_app: { url: waUrl(`pass_${SERVER_NUM}_server_${SAP_FALLBACK}`) } });
  }
  for (const p of projects) {
    const papSecret = p.pap?.token?.replace(/^pap_/, '');
    const liveUrl   = `${PUBLIC_BASE}/${p.name}/`;
    const label     = p.description || p.name;
    const botTag    = p.bot?.token ? ` \u00b7 @${p.bot.bot_username}` : '';
    const row = [{ text: `\u25b6 ${label}${botTag}`, url: liveUrl }];
    if (papSecret) row.push({ text: '\u2699 dashboard', web_app: { url: waUrl(`pass_${SERVER_NUM}_project_${papSecret}`) } });
    buttons.push(row);
  }
  const count = projects.length;
  const bots  = projects.filter(p => p.bot?.token).length;
  return send(bot, chatId,
    `<b>${count} project${count !== 1 ? 's' : ''}</b> \u00b7 ${bots} bot${bots !== 1 ? 's' : ''} active`,
    { reply_markup: kbd(buttons) }
  );
}

async function handleHub(bot, chatId, owner) {
  let h = { ok: false, version: '?', uptime_sec: 0 };
  try {
    const r = await fetch(`${HUB_URL}/health`, { signal: AbortSignal.timeout(5000) });
    h = await r.json();
  } catch {}
  let projects = 0, bots = 0;
  try {
    const state = await bridge.getState();
    projects = (state.projects || []).length;
    bots     = (state.projects || []).filter(p => p.bot?.token).length;
  } catch {}
  const text =
    `<b>Hub ${h.version}</b> \u2014 ${h.ok ? 'online' : 'degraded'}\n`+
    `Projects: ${projects} \u00b7 Bots: ${bots}\n`+
    `Uptime: ${Math.floor((h.uptime_sec || 0)/60)}m \u00b7 ${PUBLIC_BASE}\n`+
    `<i>master-bot running in container hub-bot-${BOT_ID}-${PROJECT}</i>`;
  const buttons = [];
  if (owner && SAP_FALLBACK) {
    const currentMode = await getMode(chatId);
    const nextMode    = currentMode === 'stage' ? 'prod' : 'stage';
    const modeLabel   = currentMode === 'stage' ? '\u2699 switch to PROD' : '\u2699 switch to STAGE';
    buttons.push([{ text: modeLabel, callback_data: `mode:${nextMode}` }]);
    buttons.push({ text: '\u2609 Server dashboard', web_app: { url: waUrl(`pass_${SERVER_NUM}_server_${SAP_FALLBACK}`) } });
    try {
      const state = await bridge.getState();
      for (const p of state.projects || []) {
        const papSecret = p.pap?.token?.replace(/^pap_/, '');
        if (papSecret) {
          const label  = p.description || p.name;
          const botTag = p.bot?.token ? ` @${p.bot.bot_username}` : '';
          buttons.push({ text: `\u2699 ${label}${botTag}`, web_app: { url: waUrl(`pass_${SERVER_NUM}_project_${papSecret}`) } });
        }
      }
    } catch {}
  } else {
    buttons.push({ text: 'hub.labs.co', url: PUBLIC_BASE });
  }
  return send(bot, chatId, text, { reply_markup: kbd(buttons) });
}

async function handleHelp(bot, chatId, owner) {
  let text =
    `/start \u2014 welcome\n`+
    `/new \u2014 connect or create anything\n`+
    `/my \u2014 my projects\n`+
    `/buffer \u2014 my buffer\n`+
    `/hub \u2014 server status\n`+
    `/help \u2014 this list`;
  if (owner) text += `\n\n<b>Owner</b>\n/signin \u2014 server access\n/id \u2014 your ID`;
  return send(bot, chatId, text);
}

async function handleSignin(bot, chatId) {
  if (!SAP_FALLBACK) {
    return send(bot, chatId, '\u26a0 SAP token not available to this container.');
  }
  const passToken = `pass_${SERVER_NUM}_server_${SAP_FALLBACK}`;
  return send(bot, chatId,
    `<b>Server access</b>\n\n<i>Do not share.</i>`,
    { reply_markup: kbd([
        [{ text: '\u2609 Open in Telegram', web_app: { url: waUrl(passToken) } }],
        [{ text: '\u2609 Open in browser',  url: `${PUBLIC_BASE}/signin/${passToken}` }],
    ]) }
  );
}

// ── Intake ───────────────────────────────────────────────────────────────────────────────
async function handleIntake(bot, chatId, text, _owner) {
  const { type, value } = recognise(text);
  switch (type) {
    case 'pass_sap':
      return send(bot, chatId, `\u2609 Server dashboard`,
        { reply_markup: kbd([[{ text: '\u2609 Open dashboard', web_app: { url: waUrl(value) } }]]) });

    case 'pass_pap': {
      let passTok = value;
      if (value.startsWith('pap_')) passTok = `pass_${SERVER_NUM}_project_${value.replace(/^pap_/, '')}`;
      return send(bot, chatId, `\u2699 Project dashboard`,
        { reply_markup: kbd([[{ text: '\u2699 Open dashboard', web_app: { url: waUrl(passTok) } }]]) });
    }

    case 'telegram_bot_token': {
      try {
        const r = await fetch(`https://api.telegram.org/bot${value}/getMe`);
        const j = await r.json();
        if (!j.ok) return send(bot, chatId, `\u274c Not a valid bot token.\n\n<i>${j.description}</i>`);
        return send(bot, chatId,
          `\u2705 Valid bot: <b>@${j.result.username}</b>\n\n` +
          `(Auto-attach to a project requires the bridge endpoint for project-bot wiring \u2014 deferred to a future patch. ` +
          `For now, copy the token into the project dashboard manually.)`
        );
      } catch (e) { return send(bot, chatId, `\u274c ${e.message}`); }
    }

    case 'url':
      return send(bot, chatId, `\u2705 URL saved to buffer.\n\n<code>${escHtml(value)}</code>`);

    case 'project_name':
    case 'wizard_payload':
    case 'openrouter_key':
    case 'openai_key':
    case 'anthropic_key':
      return send(bot, chatId,
        `\u26a0 <b>This action requires legacy in-Hub handlers.</b>\n\n` +
        `Master-bot is currently running from a container; the project-creation flow ` +
        `still lives in the old master.js path. The wizard at ${PUBLIC_BASE}/hub/wizard works fully.`,
        { reply_markup: kbd([[{ text: '\u2728 Open Wizard', web_app: { url: wizUrl(chatId) } }]])
      });

    default:
      return send(bot, chatId,
        `Saved to buffer.\n\n` +
        `I understand: bot token, project name, API key, URL, pass link.\n\n` +
        `Or open the Wizard:`,
        { reply_markup: kbd([[{ text: '\u2728 Open Wizard', web_app: { url: wizUrl(chatId) } }]]) }
      );
  }
}
