// modules/botctl/index.js — orchestrator module entry
//
// What this does:
//   - Manages per-bot Docker containers (spawn, stop, restart, status, logs)
//   - Reads/writes the `bots` Postgres table
//   - Exposes read-only HTTP endpoints under SAP for inspection
//
// What this does NOT do (yet):
//   - Replace existing bots in master.js (step 6)
//   - Telegram-facing UI (step 7)
//   - Mutating HTTP endpoints — those land alongside step 7

import * as docker from './docker.js';
import * as db from './db.js';
import * as lifecycle from './lifecycle.js';
import { makeAuthMiddleware } from '../../hub/credentials.js';

let _ctx;

export async function init(ctx) {
  _ctx = ctx;
  await docker.ping();
  await db.init();
  ctx.logger.info('[botctl] ready (docker socket OK, postgres OK)');
}

export function mountRoutes(app, ctx) {
  const { authSAP } = makeAuthMiddleware(ctx);

  // GET /hub/botctl/ping — verify Docker socket is reachable
  app.get('/hub/botctl/ping', authSAP, async (req, res) => {
    try {
      const v = await docker.version();
      res.json({
        ok: true,
        docker: { version: v.Version, api: v.ApiVersion, kernel: v.KernelVersion },
      });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // GET /hub/botctl/bots — list bot rows from Postgres (token redacted)
  app.get('/hub/botctl/bots', authSAP, async (req, res) => {
    try {
      const filter = {};
      if (req.query.status)  filter.status  = String(req.query.status);
      if (req.query.owner)   filter.owner   = String(req.query.owner);
      if (req.query.project) filter.project = String(req.query.project);
      const rows = await db.listBots(filter);
      const safe = rows.map((r) => ({ ...r, bot_token: r.bot_token ? '[REDACTED]' : null }));
      res.json({ ok: true, count: safe.length, bots: safe });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /hub/botctl/containers — list Hub-managed Docker containers
  app.get('/hub/botctl/containers', authSAP, async (req, res) => {
    try {
      const containers = await lifecycle.listManagedContainers();
      res.json({ ok: true, count: containers.length, containers });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /hub/botctl/bots/:id/status — DB row + live Docker inspect
  app.get('/hub/botctl/bots/:id/status', authSAP, async (req, res) => {
    try {
      const status = await lifecycle.getStatus(parseInt(req.params.id, 10));
      if (status.bot && status.bot.bot_token) status.bot.bot_token = '[REDACTED]';
      res.json({ ok: true, ...status });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /hub/botctl/bots/:id/logs?n=100 — demuxed container stdout/stderr
  app.get('/hub/botctl/bots/:id/logs', authSAP, async (req, res) => {
    try {
      const n = Math.min(parseInt(req.query.n) || 100, 1000);
      const logs = await lifecycle.tailLogs(parseInt(req.params.id, 10), n);
      res.json({ ok: true, count: logs.length, logs });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  ctx.logger.info('[botctl] mounted /hub/botctl/{ping,bots,containers,bots/:id/status,bots/:id/logs}');
}

// Programmatic API for other modules (e.g. wizard for spawn after bot creation)
export { docker, db, lifecycle };
