// modules/buffer/index.js — Hub Buffer
// Personal KV store per Telegram user.
// Every non-command message in @LabsHubBot is auto-saved here.
// /buffer command shows latest entries + public feed URL.
// Public feed: GET /buffer/:telegramId  — JSON array, newest first.

import fs       from 'fs';
import path     from 'path';
import Database from 'better-sqlite3';

const KV_MAX_KEY_LEN = 512;
const BUFFER_MAX     = 200;   // max entries per user
const ENTRY_MAX_BYTES = 8192;

const cache = new Map();

// One SQLite DB per Telegram user at:
//   {dataDir}/buffer/{telegramId}.db
function dbPath(dataDir, telegramId) {
  const dir = path.join(dataDir, 'buffer');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(telegramId)}.db`);
}

function openDb(dataDir, telegramId) {
  const key = `buf:${telegramId}`;
  if (cache.has(key)) return cache.get(key);
  const db = new Database(dbPath(dataDir, telegramId));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      text      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      kind      TEXT NOT NULL DEFAULT 'text'
    );
    CREATE INDEX IF NOT EXISTS idx_buf_ts ON entries(ts DESC);
  `);
  const stmts = {
    add:    db.prepare('INSERT INTO entries(text, ts, kind) VALUES(?, ?, ?)'),
    list:   db.prepare('SELECT id, text, ts, kind FROM entries ORDER BY ts DESC LIMIT ?'),
    count:  db.prepare('SELECT COUNT(*) AS n FROM entries'),
    clear:  db.prepare('DELETE FROM entries'),
    trim:   db.prepare('DELETE FROM entries WHERE id NOT IN (SELECT id FROM entries ORDER BY ts DESC LIMIT ?)'),
  };
  const kv = { db, stmts };
  cache.set(key, kv);
  return kv;
}

// Public API used by master.js
export function bufferAdd(dataDir, telegramId, text, kind = 'text') {
  try {
    const { stmts } = openDb(dataDir, String(telegramId));
    const trimmed   = String(text).slice(0, ENTRY_MAX_BYTES);
    stmts.add.run(trimmed, Date.now(), kind);
    stmts.trim.run(BUFFER_MAX);
    return true;
  } catch { return false; }
}

export function bufferList(dataDir, telegramId, limit = 20) {
  try {
    const { stmts } = openDb(dataDir, String(telegramId));
    return stmts.list.all(limit);
  } catch { return []; }
}

export function bufferCount(dataDir, telegramId) {
  try {
    const { stmts } = openDb(dataDir, String(telegramId));
    return stmts.count.get()?.n || 0;
  } catch { return 0; }
}

export function bufferClear(dataDir, telegramId) {
  try {
    const { stmts } = openDb(dataDir, String(telegramId));
    stmts.clear.run();
    return true;
  } catch { return false; }
}

// KV store API (existing, kept for other modules)
function openKv(dataDir, projectName) {
  const key = `kv:${projectName}`;
  if (cache.has(key)) return cache.get(key);
  const dir = path.join(dataDir, 'buffer');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, `${projectName}.kv.db`));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      k          TEXT PRIMARY KEY,
      v          BLOB NOT NULL,
      expires_at INTEGER,
      bytes      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kv_prefix ON kv(k);
    CREATE INDEX IF NOT EXISTS idx_kv_expiry ON kv(expires_at) WHERE expires_at IS NOT NULL;
  `);
  const stmts = {
    get:      db.prepare('SELECT v, expires_at FROM kv WHERE k = ?'),
    set:      db.prepare('INSERT OR REPLACE INTO kv(k, v, expires_at, bytes) VALUES(?, ?, ?, ?)'),
    del:      db.prepare('DELETE FROM kv WHERE k = ?'),
    list:     db.prepare('SELECT k, v, expires_at FROM kv WHERE k LIKE ? ORDER BY k LIMIT 1000'),
    sumBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM kv'),
  };
  function checkKey(k) {
    if (typeof k !== 'string' || !k.length) throw new Error('kv: key must be non-empty string');
    if (k.length > KV_MAX_KEY_LEN) throw new Error('kv: key too long');
  }
  function maybeExpired(row, k) {
    if (!row) return null;
    if (row.expires_at && row.expires_at <= Date.now()) { stmts.del.run(k); return null; }
    return row;
  }
  function decodeValue(blob) {
    try { return JSON.parse(blob.toString('utf8')); } catch { return null; }
  }
  const kv = {
    get(k) { checkKey(k); const row = maybeExpired(stmts.get.get(k), k); return row ? decodeValue(row.v) : null; },
    set(k, value, ttlMs) {
      checkKey(k);
      const buf  = Buffer.from(JSON.stringify(value), 'utf8');
      const exp  = ttlMs ? Date.now() + ttlMs : null;
      stmts.set.run(k, buf, exp, buf.length);
    },
    del(k) { checkKey(k); stmts.del.run(k); },
    list(prefix = '') { return stmts.list.all(prefix + '%').filter(r => maybeExpired(r, r.k)).map(r => ({ k: r.k, v: decodeValue(r.v) })); },
    bytes() { return stmts.sumBytes.get().total; },
    _internal: { db },
  };
  cache.set(key, kv);
  return kv;
}

// ── Module contract ────────────────────────────────────────────────────────────

let _ctx;

export async function init(ctx) {
  _ctx = ctx;
  ctx.logger.info('[buffer] ready (personal KV + buffer per user)');
}

export function getKv(projectName) {
  return openKv(_ctx.config.dataDir, projectName);
}

export function mountRoutes(app, ctx) {
  _ctx = ctx;

  // Public buffer feed: GET /buffer/:telegramId
  // Returns JSON array of recent entries, newest first.
  app.get('/buffer/:telegramId', (req, res) => {
    const id    = String(req.params.telegramId).replace(/[^0-9a-zA-Z_-]/g, '');
    if (!id) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const entries = bufferList(ctx.config.dataDir, id, limit);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok:      true,
      id,
      count:   entries.length,
      entries: entries.map(e => ({
        id:   e.id,
        text: e.text,
        ts:   e.ts,
        kind: e.kind,
        date: new Date(e.ts).toISOString(),
      })),
    });
  });

  ctx.logger.info('[buffer] mounted /buffer/:telegramId');
}
