// modules/telegram/projects.js — per-project bot polling + dispatch
// Lifted from drafts/project-bots.js. Wires updates into the runtime module.

import fs from 'fs';
import { startCronForProject, stopCronForProject, init as cronInit } from '../runtime/cron.js';

let _ctx;
const pollingBots = new Map(); // projectName → { interval, token }

const POLL_INTERVAL_MS = 1000;

async function tgApi(token, method, params = {}) {
  const res  = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  return res.json();
}

export function getBotStatus(project) {
  const b = project.bot;
  if (!b?.token) return { attached: false };
  return {
    attached: true, bot_username: b.bot_username || null,
    mode: b.webhook_url ? 'webhook' : 'default',
    webhook_url: b.webhook_url || null,
    subscribers: (b.subscribers || []).length,
    analytics_enabled: b.analytics_enabled !== false,
    last_synced_at: b.last_synced_at || null,
  };
}


async function setProjectCommands(token, project) {
  const base = _ctx.config.publicBase;
  // Load project-defined commands from bot.json
  let projectCmds = [];
  try {
    const botJson = _ctx.modules.drafts?.getBotJson?.(project.name);
    if (botJson?.commands) {
      projectCmds = botJson.commands
        .filter(c => c.command && c.description)
        .map(c => ({ command: c.command.replace(/^\//, ''), description: c.description }));
    }
  } catch {}

  // Hub footer: /hub /help /start always last
  const footer = [
    { command: 'hub',   description: 'Hub status' },
    { command: 'help',  description: 'All commands' },
    { command: 'start', description: 'Welcome' },
  ];

  // Remove footer commands from project commands to avoid duplicates
  const footerKeys = new Set(footer.map(c => c.command));
  const filtered = projectCmds.filter(c => !footerKeys.has(c.command));

  const commands = [...filtered, ...footer];
  await tgApi(token, 'setMyCommands', {
    commands,
    scope: { type: 'all_private_chats' },
  });
}

async function startProjectPolling(project) {
  const name  = project.name;
  const token = project.bot?.token;
  if (!token || pollingBots.has(name)) return;

  // Set command menu: project commands from bot.json + hub footer
  setProjectCommands(token, project).catch(() => {});

  let offset = 0;
  const log  = _ctx.logger.child('bot:' + name);

  const poll = async () => {
    if (!project.bot?.token) { stopProjectPolling(name); return; }
    try {
      const result = await tgApi(token, 'getUpdates', { offset, timeout: 10, allowed_updates: ['message','callback_query','my_chat_member'] });
      if (result.ok && result.result?.length) {
        for (const update of result.result) {
          offset = update.update_id + 1;
          try {
            if (project.bot.analytics_enabled !== false)
              _ctx.modules.analytics?.recordUpdate(name, update);
            trackSubscriber(project, update);
            if (!project.bot.webhook_url) {
              const handled = await _ctx.modules.runtime?.dispatchBotUpdate(project, update);
              if (!handled?.handled) await defaultReply(token, update, project);
            } else {
              await forwardWebhook(project, update);
            }
          } catch (e) { log.error('update dispatch error:', e.message); }
        }
      }
    } catch (e) { log.warn('poll error:', e.message); }
  };

  const interval = setInterval(poll, POLL_INTERVAL_MS);
  pollingBots.set(name, { interval, token });
  log.info('polling started');
}

export function stopProjectPolling(name) {
  stopCronForProject(name);
  const entry = pollingBots.get(name);
  if (entry) { clearInterval(entry.interval); pollingBots.delete(name); }
}

function trackSubscriber(project, update) {
  if (!project.bot) return;
  const msg = update.message;
  if (!msg?.from) return;
  const userId = String(msg.from.id);
  project.bot.subscribers = project.bot.subscribers || [];
  if (msg.text === '/start' && !project.bot.subscribers.includes(userId)) {
    project.bot.subscribers.push(userId);
    _ctx.modules.drafts?.saveState();
  } else if (msg.text === '/stop') {
    project.bot.subscribers = project.bot.subscribers.filter(id => id !== userId);
    _ctx.modules.drafts?.saveState();
  }
}

async function defaultReply(token, update, project) {
  const msg = update.message;
  if (!msg) return;
  const liveUrl = `${_ctx.config.publicBase}/${project.name}/`;
  await tgApi(token, 'sendMessage', {
    chat_id: msg.chat.id,
    text: `<b>${project.bot.bot_username || project.name}</b>\n\n<a href="${liveUrl}">${liveUrl}</a>`,
    parse_mode: 'HTML',
  });
}

async function forwardWebhook(project, update) {
  const url = project.bot.webhook_url;
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Project': project.name,
        'X-Hub-Update-Id': String(update.update_id),
        'X-Hub-Bot-Username': project.bot.bot_username || '',
      },
      body: JSON.stringify(update),
    });
  } catch (e) {
    _ctx.logger.warn('[bot:' + project.name + '] webhook forward failed:', e.message);
  }
}

export async function installBot(project, token, opts = {}) {
  const me = await tgApi(token, 'getMe');
  if (!me.ok) throw new Error('invalid_token: ' + me.description);
  project.bot = {
    token,
    bot_id: me.result.id,
    bot_username: me.result.username,
    subscribers: project.bot?.subscribers || [],
    webhook_url: opts.webhook_url || null,
    webhook_log: [],
    analytics_enabled: true,
    last_synced_at: new Date().toISOString(),
  };
  _ctx.modules.drafts.saveState();
  stopProjectPolling(project.name);
  await startProjectPolling(project);
  return getBotStatus(project);
}

export async function unlinkBot(project, opts = {}) {
  stopProjectPolling(project.name);
  const username = project.bot?.bot_username;
  project.bot = null;
  _ctx.modules.drafts.saveState();
  return { unlinked: username };
}

export async function broadcast(project, html) {
  const token = project.bot?.token;
  if (!token) throw new Error('no_bot');
  const subs = project.bot.subscribers || [];
  let ok = 0, failed = 0;
  for (const userId of subs) {
    try { await tgApi(token, 'sendMessage', { chat_id: Number(userId), text: html, parse_mode: 'HTML' }); ok++; }
    catch { failed++; }
  }
  return { sent: ok, failed, total: subs.length };
}

export async function init(ctx) {
  _ctx = ctx;
  // Defer bot startup to ensure drafts module is loaded
  setTimeout(() => {
    const st = _ctx.modules.drafts?.getState?.();
    if (st) {
      for (const p of st.projects) {
        if (p.bot?.token && !p.bot?.webhook_url) {
          startProjectPolling(p).catch(e => _ctx.logger.warn('[projects-bot] start failed for', p.name + ':', e.message));
        }
      }
    }
    cronInit(_ctx);
    const allProjects = _ctx.modules.drafts?.getState?.()?.projects || [];
    for (const p of allProjects) {
      if (p.bot?.token) startCronForProject(p);
    }
  }, 500);
  ctx.logger.info('[telegram/projects] ready, bots started:', pollingBots.size);
  cronInit(ctx);
  const allProjects = _ctx.modules.drafts?.getState?.()?.projects || [];
  for (const p of allProjects) {
    if (p.bot?.token) startCronForProject(p);
  }
}
