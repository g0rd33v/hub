// modules/bridge/index.js — Hub-Internal HTTP bridge for containerized core bots
//
// Why this exists:
// The master-bot (@LabsHubBot) is moving from in-process inside Hub PM2 to its
// own Docker container (v0.5). Inside the container it can't reach Hub's JS
// objects (drafts state, buffer SQLite, etc) directly. This module exposes the
// minimum surface needed by master.js as authenticated HTTP endpoints.
//
// Auth: HMAC-SHA256(SAP, `${botId}:${project}`) — same scheme as the runtime KV
// proxy planned for runner v0.6. Token minted by botctl.lifecycle.spawn() and
// injected as KV_TOKEN env var into the container. host.docker.internal:3100
// is reachable from the container via ExtraHosts (botctl already configures).
//
// Endpoints (all under SAP middleware OR HMAC bridge auth, with x-hub-bot-id
// + x-hub-project headers):
//   GET  /internal/bridge/ping
//   POST /internal/bridge/buffer/add     {tg, text, kind?}
//   POST /internal/bridge/buffer/list    {tg, limit?}
//   POST /internal/bridge/buffer/count   {tg}
//   POST /internal/bridge/buffer/clear   {tg}
//   POST /internal/bridge/userkv/get     {tg, key}
//   POST /internal/bridge/userkv/set     {tg, key, value}
//   GET  /internal/bridge/state
//   POST /internal/bridge/state          {state}     (full save)
//   GET  /internal/bridge/findProjectByPAP/:tok
//   GET  /internal/bridge/findProjectAndAAPByAAPToken/:tok
//
// All endpoints return {ok:true,...} on success or {ok:false,error} on failure.

import crypto from 'crypto';
import fs     from 'fs';
import path   from 'path';

let _ctx = null;

export async function init(ctx) {
  _ctx = ctx;
  ctx.logger.info('[bridge] ready');
}

function loadSAP() {
  try { return fs.readFileSync('/etc/hub/sap.token', 'utf8').trim(); }
  catch { return null; }
}

function safeEq(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function hmacToken(sap, botId, project) {
  return crypto.createHmac('sha256', sap)
    .update(`${botId}:${project}`)
    .digest('hex');
}

// User-KV fallback: Hub's master.js calls _ctx.modules.buffer.userKvGet/Set
// but those don't exist in buffer/index.js. They live as `_user_<tgId>.kv.db`
// SQLite files used by master.js to remember per-user state. Reproduce here.
function openUserKv(tgId) {
  const Database = (() => { try { return require('better-sqlite3'); } catch { return null; } })();
  // ESM-friendly fallback
  if (!Database) return null;
  const dir = path.join(_ctx.config.dataDir, 'buffer');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, `_user_${tgId}.kv.db`));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  return db;
}

async function importBetterSqlite() {
  const m = await import('better-sqlite3');
  return m.default;
}

let _userKvCache = new Map();
async function userKv(tgId) {
  const key = `ukv:${tgId}`;
  if (_userKvCache.has(key)) return _userKvCache.get(key);
  const Database = await importBetterSqlite();
  const dir = path.join(_ctx.config.dataDir, 'buffer');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, `_user_${String(tgId).replace(/[^0-9]/g,'')}.kv.db`));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
  const stmts = {
    get: db.prepare('SELECT v FROM kv WHERE k = ?'),
    set: db.prepare('INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)'),
  };
  const o = {
    get(k) { const r = stmts.get.get(k); if (!r) return null; try { return JSON.parse(r.v); } catch { return null; } },
    set(k, v) { stmts.set.run(k, JSON.stringify(v ?? null)); },
  };
  _userKvCache.set(key, o);
  return o;
}

// ── Auth middleware ────────────────────────────────────────────────────────────
// Accepts EITHER:
//   - SAP Bearer (full admin)
//   - HMAC-Bearer with x-hub-bot-id + x-hub-project headers (per-bot scoped)

function makeBridgeAuth() {
  return async (req, res, next) => {
    const auth = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return res.status(401).json({ ok: false, error: 'missing_bearer' });
    const tok = m[1];
    const sap = loadSAP();
    if (!sap) return res.status(503).json({ ok: false, error: 'sap_unavailable' });

    // Path A: full SAP
    if (safeEq(tok, sap)) { req.bridge = { mode: 'sap' }; return next(); }

    // Path B: per-bot HMAC
    const botId   = String(req.headers['x-hub-bot-id'] || '');
    const project = String(req.headers['x-hub-project'] || '');
    if (!botId || !project) return res.status(401).json({ ok: false, error: 'missing_scope_headers' });
    if (!_ctx.modules.botctl) return res.status(503).json({ ok: false, error: 'botctl_unavailable' });

    // Verify the bot exists with this project AND the HMAC matches
    try {
      const bot = await _ctx.modules.botctl.db.getBot(parseInt(botId, 10));
      if (!bot)                          return res.status(403).json({ ok: false, error: 'bot_not_found' });
      if (bot.project_name !== project && bot.bot_username !== project) {
        return res.status(403).json({ ok: false, error: 'project_mismatch' });
      }
      const expected = hmacToken(sap, bot.id, project);
      if (!safeEq(tok, expected)) return res.status(403).json({ ok: false, error: 'bad_hmac' });
      req.bridge = { mode: 'hmac', bot, project };
      return next();
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

export function mountRoutes(app, ctx) {
  _ctx = ctx;
  const auth = makeBridgeAuth();
  const buffer = ctx.modules.buffer;
  const drafts = ctx.modules.drafts;

  app.get('/internal/bridge/ping', auth, (req, res) => {
    res.json({ ok: true, mode: req.bridge.mode, modules_available: { buffer: !!buffer, drafts: !!drafts } });
  });

  // ── Buffer ───────────────────────────────────────────────────────────────
  app.post('/internal/bridge/buffer/add', auth, (req, res) => {
    if (!buffer) return res.status(503).json({ ok: false, error: 'buffer_module_missing' });
    const { tg, text, kind } = req.body || {};
    if (!tg || typeof text !== 'string') return res.status(400).json({ ok: false, error: 'tg_and_text_required' });
    const ok = buffer.bufferAdd(ctx.config.dataDir, String(tg), text, kind || 'text');
    res.json({ ok });
  });

  app.post('/internal/bridge/buffer/list', auth, (req, res) => {
    if (!buffer) return res.status(503).json({ ok: false, error: 'buffer_module_missing' });
    const { tg, limit } = req.body || {};
    if (!tg) return res.status(400).json({ ok: false, error: 'tg_required' });
    res.json({ ok: true, entries: buffer.bufferList(ctx.config.dataDir, String(tg), limit) });
  });

  app.post('/internal/bridge/buffer/count', auth, (req, res) => {
    if (!buffer) return res.status(503).json({ ok: false, error: 'buffer_module_missing' });
    const { tg } = req.body || {};
    if (!tg) return res.status(400).json({ ok: false, error: 'tg_required' });
    res.json({ ok: true, count: buffer.bufferCount(ctx.config.dataDir, String(tg)) });
  });

  app.post('/internal/bridge/buffer/clear', auth, (req, res) => {
    if (!buffer) return res.status(503).json({ ok: false, error: 'buffer_module_missing' });
    const { tg } = req.body || {};
    if (!tg) return res.status(400).json({ ok: false, error: 'tg_required' });
    res.json({ ok: buffer.bufferClear(ctx.config.dataDir, String(tg)) });
  });

  // ── User-KV (per-Telegram-user state used by master.js) ──────────────────
  app.post('/internal/bridge/userkv/get', auth, async (req, res) => {
    const { tg, key } = req.body || {};
    if (!tg || !key) return res.status(400).json({ ok: false, error: 'tg_and_key_required' });
    try {
      const kv = await userKv(tg);
      res.json({ ok: true, value: kv.get(String(key)) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/internal/bridge/userkv/set', auth, async (req, res) => {
    const { tg, key, value } = req.body || {};
    if (!tg || !key) return res.status(400).json({ ok: false, error: 'tg_and_key_required' });
    try {
      const kv = await userKv(tg);
      kv.set(String(key), value);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Drafts state ─────────────────────────────────────────────────────────
  app.get('/internal/bridge/state', auth, (req, res) => {
    if (!drafts) return res.status(503).json({ ok: false, error: 'drafts_module_missing' });
    try {
      res.json({ ok: true, state: drafts.getState() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/internal/bridge/state', auth, (req, res) => {
    if (!drafts) return res.status(503).json({ ok: false, error: 'drafts_module_missing' });
    if (req.bridge.mode !== 'sap') return res.status(403).json({ ok: false, error: 'sap_required_for_state_write' });
    const { state } = req.body || {};
    if (!state || typeof state !== 'object') return res.status(400).json({ ok: false, error: 'state_object_required' });
    try {
      drafts.saveState(state);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/internal/bridge/findProjectByPAP/:tok', auth, (req, res) => {
    if (!drafts) return res.status(503).json({ ok: false, error: 'drafts_module_missing' });
    try {
      res.json({ ok: true, project: drafts.findProjectByPAP(String(req.params.tok)) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/internal/bridge/findProjectAndAAPByAAPToken/:tok', auth, (req, res) => {
    if (!drafts) return res.status(503).json({ ok: false, error: 'drafts_module_missing' });
    try {
      res.json({ ok: true, found: drafts.findProjectAndAAPByAAPToken(String(req.params.tok)) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  ctx.logger.info('[bridge] mounted /internal/bridge/* (SAP or per-bot HMAC auth)');
}
