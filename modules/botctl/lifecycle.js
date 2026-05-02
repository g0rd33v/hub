// modules/botctl/lifecycle.js — high-level bot operations (v0.5.1)
// Coordinates DB + Docker. Resource limits come from DB, never from caller.
//
// v0.5.1: spawns containers with Hub-compatible runner ABI:
//   - injects PROJECT, HUB_URL, KV_TOKEN env vars
//   - mounts /var/lib/hub/projects/<project>/live -> /app/user:ro for full Hub-compat
//   - adds host-gateway entry so containers can reach the host (where Hub runs)

import crypto from 'crypto';
import * as docker from './docker.js';
import * as db from './db.js';
import { getSAP } from '../../hub/credentials.js';

const NAME_PREFIX = 'hub-bot-';
const LABEL_KEY = 'hub.managed';
const HUB_URL_FROM_CONTAINER = process.env.HUB_INTERNAL_URL || 'http://host.docker.internal:3100';

function containerName(bot) {
  return NAME_PREFIX + bot.id + '-' + bot.bot_username;
}

function kvTokenFor(botId, project) {
  const sap = getSAP();
  if (!sap) throw new Error('SAP not loaded — cannot mint KV_TOKEN');
  return crypto.createHmac('sha256', sap).update(String(botId) + ':' + String(project)).digest('hex');
}

export async function spawn(botId) {
  const bot = await db.getBot(botId);
  if (!bot) throw new Error('spawn: bot ' + botId + ' not found');
  if (bot.status === 'running') throw new Error('spawn: bot ' + botId + ' already running');
  if (!bot.project_name) throw new Error('spawn: bot ' + botId + ' has no project_name (required for KV scope)');

  // Cleanup: if a container with this name exists from a previous attempt, remove it
  const name = containerName(bot);
  const existing = await docker.listContainers({ all: true });
  for (const c of existing) {
    if (c.Names.includes('/' + name)) {
      await docker.removeContainer(c.Id, true).catch(() => {});
    }
  }

  const userMountHost = '/var/lib/hub/projects/' + bot.project_name + '/live';
  const kvToken = kvTokenFor(bot.id, bot.project_name);

  const created = await docker.createContainer({
    name,
    image: bot.container_image,
    env: [
      'BOT_TOKEN=' + bot.bot_token,
      'PROJECT=' + bot.project_name,
      'HUB_URL=' + HUB_URL_FROM_CONTAINER,
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
      'hub.bot.project':  bot.project_name,
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
      project:      c.Labels['hub.bot.project'],
    }));
}
