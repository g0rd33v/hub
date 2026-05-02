// modules/internal/index.js — internal-only endpoints for bot containers
//
// Each bot container holds a per-bot KV_TOKEN = HMAC-SHA256(SAP, "<bot_id>:<project>").
// On every KV request the container sends:
//   Authorization: Bearer <KV_TOKEN>
//   x-hub-project:  <project>
// Hub looks up all bots for that project, recomputes the HMAC for each,
// and accepts the request only if any matches (timing-safe).
//
// Endpoints (all POST, all under the same auth):
//   /internal/kv/ping  body: {}              → {ok:true, project}
//   /internal/kv/get   body: {key}           → {ok:true, value}   (value=null if missing)
//   /internal/kv/set   body: {key, value}    → {ok:true}
//   /internal/kv/del   body: {key}           → {ok:true}
//
// KV is delegated to the existing buffer module: ctx.modules.buffer.getKv(project),
// so containers read/write the same SQLite files Hub itself uses.

import crypto from 'crypto';
import fs from 'fs';

let _ctx;
let _sap = null;

export async function init(ctx) {
  _ctx = ctx;
  _sap = fs.readFileSync(ctx.paths.sapToken(), 'utf8').trim();
  if (!_sap) throw new Error('[internal] SAP token empty');
  ctx.logger.info('[internal] ready (KV proxy auth via SAP-HMAC)');
}

function getBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function validateToken(token, project) {
  const botctl = _ctx.modules?.botctl;
  if (!botctl) return null;
  const bots = await botctl.db.listBots({ project });
  if (!bots.length) return null;
  for (const bot of bots) {
    const expected = crypto
      .createHmac('sha256', _sap)
      .update(bot.id + ':' + project)
      .digest('hex');
    if (
      token.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    ) {
      return bot;
    }
  }
  return null;
}

export function mountRoutes(app, ctx) {
  const auth = async (req, res, next) => {
    try {
      const project = req.headers['x-hub-project'];
      if (!project || typeof project !== 'string') {
        return res.status(401).json({ ok: false, error: 'x-hub-project header required' });
      }
      const token = getBearer(req);
      if (!token) {
        return res.status(401).json({ ok: false, error: 'bearer token required' });
      }
      const bot = await validateToken(token, project);
      if (!bot) {
        return res.status(401).json({ ok: false, error: 'invalid token for project' });
      }
      req.bot = bot;
      req.project = project;
      next();
    } catch (e) {
      ctx.logger.error('[internal] auth error: ' + e.message);
      res.status(500).json({ ok: false, error: 'auth check failed' });
    }
  };

  app.post('/internal/kv/ping', auth, (req, res) => {
    res.json({ ok: true, project: req.project, bot_id: req.bot.id });
  });

  app.post('/internal/kv/get', auth, async (req, res) => {
    try {
      const { key } = req.body || {};
      if (!key || typeof key !== 'string') {
        return res.status(400).json({ ok: false, error: 'key required' });
      }
      const kv = ctx.modules.buffer?.getKv?.(req.project);
      if (!kv) return res.status(500).json({ ok: false, error: 'buffer kv unavailable' });
      const value = await Promise.resolve(kv.get(key));
      res.json({ ok: true, value: value === undefined ? null : value });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/internal/kv/set', auth, async (req, res) => {
    try {
      const { key, value } = req.body || {};
      if (!key || typeof key !== 'string') {
        return res.status(400).json({ ok: false, error: 'key required' });
      }
      const kv = ctx.modules.buffer?.getKv?.(req.project);
      if (!kv) return res.status(500).json({ ok: false, error: 'buffer kv unavailable' });
      await Promise.resolve(kv.set(key, value));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/internal/kv/del', auth, async (req, res) => {
    try {
      const { key } = req.body || {};
      if (!key || typeof key !== 'string') {
        return res.status(400).json({ ok: false, error: 'key required' });
      }
      const kv = ctx.modules.buffer?.getKv?.(req.project);
      if (!kv) return res.status(500).json({ ok: false, error: 'buffer kv unavailable' });
      const deleter = kv.delete || kv.del;
      if (typeof deleter !== 'function') {
        return res.status(500).json({ ok: false, error: 'kv has no delete method' });
      }
      await Promise.resolve(deleter.call(kv, key));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  ctx.logger.info('[internal] mounted /internal/kv/{ping,get,set,del}');
}
