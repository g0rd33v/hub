// modules/internal/index.js — internal-only HTTP endpoints for bot containers.
//
// Bot containers (running hub-bot-runner) talk back to Hub for KV access.
// They send Bearer KV_TOKEN where KV_TOKEN = HMAC-SHA256(SAP, '<botId>:<project>').
// Hub recomputes and timing-safe-compares; if it matches AND the project header
// matches the project bound to that bot, the call is authorised — strictly
// scoped to that one project's KV.
//
// Endpoints (all under POST /internal/kv/*):
//   /internal/kv/ping           {ok:true}
//   /internal/kv/get   {key}    -> {ok, value}
//   /internal/kv/set   {key, value}
//   /internal/kv/del   {key}
//   /internal/kv/list  {prefix?}

import crypto from 'crypto';
import { getSAP } from '../../hub/credentials.js';

let _ctx;

export async function init(ctx) {
  _ctx = ctx;
  ctx.logger.info('[internal] ready');
}

function expectedTokenFor(botId, project) {
  const sap = getSAP();
  if (!sap) return null;
  return crypto.createHmac('sha256', sap).update(String(botId) + ':' + String(project)).digest('hex');
}

function safeEqHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Validate Bearer KV_TOKEN against bot row in DB.
// On success returns { botId, project }. On failure returns null.
async function authBot(req) {
  if (!_ctx.modules.botctl) return null;
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+([0-9a-f]{64})$/i);
  if (!m) return null;
  const got = m[1].toLowerCase();
  const project = req.headers['x-hub-project'];
  if (!project) return null;

  const bot = await _ctx.modules.botctl.db.getBotByUsername(/* fallback below */ '___nope___').catch(() => null);
  // Token is bound to (botId, project). We look up by project to get botId.
  // Faster path: query all bots with this project, find one whose HMAC matches.
  const candidates = await _ctx.modules.botctl.db.listBots({ project }).catch(() => []);
  for (const b of candidates) {
    const expected = expectedTokenFor(b.id, b.project_name || project);
    if (expected && safeEqHex(got, expected)) {
      return { botId: b.id, project: b.project_name || project };
    }
  }
  return null;
}

export function mountRoutes(app, ctx) {
  // Bind only to internal routes — no SAP, but HMAC-bound token + project header.
  app.post('/internal/kv/ping', async (req, res) => {
    const auth = await authBot(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.json({ ok: true, project: auth.project, bot_id: auth.botId });
  });

  app.post('/internal/kv/get', async (req, res) => {
    try {
      const auth = await authBot(req);
      if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { key } = req.body || {};
      if (typeof key !== 'string' || !key) return res.status(400).json({ ok: false, error: 'bad_key' });
      const kv = ctx.modules.buffer.getKv(auth.project);
      const value = kv.get(key);
      res.json({ ok: true, value: value ?? null });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/internal/kv/set', async (req, res) => {
    try {
      const auth = await authBot(req);
      if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { key, value } = req.body || {};
      if (typeof key !== 'string' || !key) return res.status(400).json({ ok: false, error: 'bad_key' });
      const kv = ctx.modules.buffer.getKv(auth.project);
      kv.set(key, value);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/internal/kv/del', async (req, res) => {
    try {
      const auth = await authBot(req);
      if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { key } = req.body || {};
      if (typeof key !== 'string' || !key) return res.status(400).json({ ok: false, error: 'bad_key' });
      const kv = ctx.modules.buffer.getKv(auth.project);
      kv.del?.(key);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  ctx.logger.info('[internal] mounted /internal/kv/{ping,get,set,del}');
}
