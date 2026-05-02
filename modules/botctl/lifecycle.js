// modules/botctl/lifecycle.js v0.5.1 — high-level bot operations
// Coordinates DB + Docker. Always validates botId against DB first.
// Resource limits come from DB, NOT from the caller (user can't grant themselves CPU).
//
// v0.5.1 changes:
//   - Mounts the project's live/ dir as /app/user:ro (was /var/lib/hub/bots/<username>)
//     so existing project bot.js + cron.json + assets work unmodified.
//   - Injects PROJECT, HUB_URL, KV_TOKEN env vars for runner v0.6's KV proxy.
//   - KV_TOKEN = HMAC-SHA256(SAP, "<bot_id>:<project>"); validated by /internal/kv/* in Hub.
//   - Adds host.docker.internal:host-gateway ExtraHost so container can reach Hub.

import crypto from 'crypto';
import fs from 'fs';
import * as docker from './docker.js';
import * as db from './db.js';

const NAME_PREFIX = 'hub-bot-';
const LABEL_KEY = 'hub.managed';

let _sap = null;
function getSap() {
  if (_sap) return _sap;
  _sap = fs.readFileSync('/etc/hub/sap.token', 'utf8').trim();
  if (!_sap) throw new Error('SAP token empty at /etc/hub/sap.token');
  return _sap;
}

function makeKvToken(botId, project) {
  return crypto.createHmac('sha256', getSap()).update(botId + ':' + project).digest('hex');
}

function containerName(bot) {
  return NAME_PREFIX + bot.id + '-' + bot.bot_username;
}

export async function spawn(botId) {
  const bot = await db.getBot(botId);
  if (!bot) throw new Error('spawn: bot ' + botId + ' not found');
  if (bot.status === 'running') throw new Error('spawn: bot ' + botId + ' already running');
  if (!bot.project_name) {
    throw new Error('spawn: bot ' + botId + ' has no project_name (required since v0.5.1 — bot must belong to a project)');
  }

  // Cleanup: if a container with this name exists from a previous attempt, remove it
  const name = containerName(bot);
  const existing = await docker.listContainers({ all: true });
  for (const c of existing) {
    if (c.Names.includes('/' + name)) {
      await docker.removeContainer(c.Id, true).catch(() => {});
    }
  }

  // Mount the project's live/ dir so existing user code (bot.js, cron.json, assets) works
  const userMountHost = '/var/lib/hub/projects/' + bot.project_name + '/live';
  if (!fs.existsSync(userMountHost)) {
    throw new Error('spawn: project live dir does not exist: ' + userMountHost);
  }

  // KV_TOKEN scoped to this bot+project; validated by Hub /internal/kv/*
  const kvToken = makeKvToken(bot.id, bot.project_name);
  const hubUrl  = process.env.HUB_URL_FROM_CONTAINER || 'http://host.docker.internal:3100';

  const created = await docker.createContainer({
    name,
    image: bot.container_image,
    env: [
      'BOT_TOKEN=' + bot.bot_token,
      'PROJECT=' + bot.project_name,
      'HUB_URL=' + hubUrl,
      'KV_TOKEN=' + kvToken,
    ],
    memMB:     bot.mem_limit_mb,
    cpuFrac:   parseFloat(bot.cpu_limit),
    pidsLimit: 128,
    binds:     [userMountHost + ':/app/user:ro'],
    extraHosts: ['host.docker.internal:host-gateway'],
    labels: {
      'hub.managed':      'true',
      'hub.bot.id':       String(bot.id),
      'hub.bot.username': bot.bot_username,
      'hub.project':      bot.project_name,
    },
  });

  await db.setContainer(botId, created.Id);
  await db.setStatus(botId, 'starting');

  await docker.startContainer(created.Id);
  await db.setStatus(botId, 'running', { startedAt: new Date() });

  return { id: created.Id, name };
}

export async function stop(botId, { remove = false } = {}) {
  const bot = await db.getBot(botId);
  if (!bot) throw new Error('stop: bot ' + botId + ' not found');
  if (!bot.container_id) {
    await db.setStatus(botId, 'stopped', { stoppedAt: new Date() });
    return { stopped: false, reason: 'no container_id' };
  }

  try {
    await docker.stopContainer(bot.container_id, 10);
  } catch (e) {
    if (!/no such container|not running|404/i.test(e.message)) throw e;
  }

  await db.setStatus(botId, 'stopped', { stoppedAt: new Date() });

  if (remove) {
    try { await docker.removeContainer(bot.container_id, true); } catch {}
    await db.setContainer(botId, null);
  }

  return { stopped: true };
}

export async function restart(botId) {
  await stop(botId, { remove: true });
  await db.setStatus(botId, 'starting', { incrementRestart: true });
  return spawn(botId);
}

export async function getStatus(botId) {
  const bot = await db.getBot(botId);
  if (!bot) return { found: false };

  let dockerInfo = null;
  if (bot.container_id) {
    try {
      const info = await docker.inspectContainer(bot.container_id);
      dockerInfo = {
        state:        info.State.Status,
        running:      info.State.Running,
        exit_code:    info.State.ExitCode,
        started_at:   info.State.StartedAt,
        finished_at:  info.State.FinishedAt,
        oom_killed:   info.State.OOMKilled,
        restart_count: info.RestartCount,
      };
    } catch (e) {
      dockerInfo = { error: e.message };
    }
  }

  return { found: true, bot, docker: dockerInfo };
}

export async function tailLogs(botId, n = 100) {
  const bot = await db.getBot(botId);
  if (!bot || !bot.container_id) return [];
  return docker.tailLogs(bot.container_id, { tail: n });
}

export async function listManagedContainers() {
  const all = await docker.listContainers({ all: true });
  return all
    .filter((c) => c.Labels?.[LABEL_KEY] === 'true')
    .map((c) => ({
      id:           c.Id.slice(0, 12),
      name:         c.Names[0]?.replace(/^\//, ''),
      image:        c.Image,
      state:        c.State,
      status:       c.Status,
      bot_id:       c.Labels['hub.bot.id'],
      bot_username: c.Labels['hub.bot.username'],
      project:      c.Labels['hub.project'] || null,
    }));
}
