// modules/buffer/index.js — per-project KV store (SQLite)
// Lifted from drafts/runtime.js. Schema unchanged — existing kv.sqlite files
// remain readable.
//
// Single owner of KV state. runtime module borrows via ctx.modules.buffer.getKv().
//
// Module contract:
//   init(ctx)             — nothing to do; KV is opened lazily per project
//   getKv(projectName)    — returns { get, set, del, list, incr }

import fs       from 'fs';
import path     from 'path';
import Database from 'better-sqlite3';

const KV_MAX_BYTES       = 10 * 1024 * 1024; // 10 MiB per project
const KV_MAX_KEY_LEN     = 512;
const KV_MAX_VALUE_BYTES = 1024 * 1024;       // 1 MiB per value

// projectName → kv instance
const cache = new Map();

function openKv(dataDir, projectName) {
  if (cache.has(projectName)) return cache.get(projectName);

  const dir = path.join(dataDir, 'projects', projectName, 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'kv.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      k          TEXT    PRIMARY KEY,
      v          BLOB    NOT NULL,
      expires_at INTEGER,
      bytes      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kv_prefix ON kv(k);
    CREATE INDEX IF NOT EXISTS idx_kv_expiry ON kv(expires_at) WHERE expires_at IS NOT NULL;
  `);

  const stmts = {
    get:       db.prepare('SELECT v, expires_at FROM kv WHERE k = ?'),
    set:       db.prepare('INSERT OR REPLACE INTO kv(k, v, expires_at, bytes) VALUES (?, ?, ?, ?)'),
    del:       db.prepare('DELETE FROM kv WHERE k = ?'),
    list:      db.prepare('SELECT k, v, expires_at FROM kv WHERE k LIKE ? ORDER BY k LIMIT 1000'),
    sumBytes:  db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM kv'),
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
    async get(k) {
      checkKey(k);
      const row = maybeExpired(stmts.get.get(k), k);
      return row ? decodeValue(row.v) : null;
    },
    async set(k, v, opts = {}) {
      checkKey(k);
      const json = JSON.stringify(v);
      if (json === undefined) throw new Error('kv: value not JSON-serializable');
      const buf       = Buffer.from(json, 'utf8');
      if (buf.length > KV_MAX_VALUE_BYTES) throw new Error('kv: value exceeds 1 MiB');
      const expiresAt = opts?.ttl ? Date.now() + opts.ttl * 1000 : null;
      const total     = stmts.sumBytes.get().total + buf.length;
      if (total > KV_MAX_BYTES) throw new Error('kv: project storage quota exceeded (10 MiB)');
      stmts.set.run(k, buf, expiresAt, buf.length);
      return true;
    },
    async del(k) {
      checkKey(k);
      return stmts.del.run(k).changes > 0;
    },
    async list(prefix) {
      if (typeof prefix !== 'string') prefix = '';
      const like = prefix.replace(/[%_]/g, ch => '\\' + ch) + '%';
      const rows = stmts.list.all(like);
      const now  = Date.now();
      const out  = [];
      for (const row of rows) {
        if (row.expires_at && row.expires_at <= now) { stmts.del.run(row.k); continue; }
        out.push({ key: row.k, value: decodeValue(row.v) });
      }
      return out;
    },
    async incr(k, by = 1) {
      checkKey(k);
      const row  = maybeExpired(stmts.get.get(k), k);
      const cur  = row ? Number(decodeValue(row.v)) || 0 : 0;
      const next = cur + (Number(by) || 1);
      const buf  = Buffer.from(JSON.stringify(next), 'utf8');
      stmts.set.run(k, buf, row ? row.expires_at : null, buf.length);
      return next;
    },
    _internal: { db },
  };

  cache.set(projectName, kv);
  return kv;
}

// ─── Module contract ────────────────────────────────────────────────────────────
let _ctx;

export async function init(ctx) {
  _ctx = ctx;
  ctx.logger.info('[buffer] ready (lazy KV open per project)');
}

export function getKv(projectName) {
  return openKv(_ctx.config.dataDir, projectName);
}

export function mountRoutes(app, ctx) {
  // No HTTP routes exposed by buffer in v0.2.
}
