// modules/botctl/db.js — Postgres client for the `bots` table
// Reads DATABASE_URL from env, falls back to /etc/hub/db.url, then to .env.prod parsing.

import fs from 'fs';
import pg from 'pg';
const { Pool } = pg;

let _pool = null;

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  // Fallback 1: /etc/hub/db.url (preferred for production)
  try {
    const url = fs.readFileSync('/etc/hub/db.url', 'utf8').trim();
    if (url) return url;
  } catch {}

  // Fallback 2: parse /opt/hub-v04/.env.prod (Hub on host, Postgres in Docker)
  try {
    const env = fs.readFileSync('/opt/hub-v04/.env.prod', 'utf8');
    const pw   = env.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1]?.trim();
    const user = env.match(/^POSTGRES_USER=(.+)$/m)?.[1]?.trim() || 'hubuser';
    const db   = env.match(/^POSTGRES_DB=(.+)$/m)?.[1]?.trim()   || 'hubdb';
    if (pw) return 'postgresql://' + user + ':' + encodeURIComponent(pw) + '@127.0.0.1:5432/' + db;
  } catch {}

  throw new Error('botctl/db: DATABASE_URL not set and no fallback files readable');
}

export async function init() {
  const url = loadDatabaseUrl();
  _pool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  await _pool.query('SELECT 1');
}

export async function shutdown() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

const SELECT_COLS = 'id, bot_username, bot_token, project_name, owner_chat_id, container_id, container_image, status, cpu_limit, mem_limit_mb, restart_count, crash_count, last_started_at, last_stopped_at, last_crash_at, last_crash_msg, created_at, updated_at';

export async function listBots(filter = {}) {
  let sql = 'SELECT ' + SELECT_COLS + ' FROM bots';
  const params = [];
  const where = [];
  if (filter.status)  { params.push(filter.status);  where.push('status = $' + params.length); }
  if (filter.owner)   { params.push(filter.owner);   where.push('owner_chat_id = $' + params.length); }
  if (filter.project) { params.push(filter.project); where.push('project_name = $' + params.length); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY id';
  const r = await _pool.query(sql, params);
  return r.rows;
}

export async function getBot(id) {
  const r = await _pool.query('SELECT ' + SELECT_COLS + ' FROM bots WHERE id = $1', [id]);
  return r.rows[0] || null;
}

export async function getBotByUsername(username) {
  const r = await _pool.query('SELECT ' + SELECT_COLS + ' FROM bots WHERE bot_username = $1', [username]);
  return r.rows[0] || null;
}

export async function insertBot({ bot_username, bot_token, project_name = null, owner_chat_id, cpu_limit = 0.5, mem_limit_mb = 256, container_image = 'hub-bot-runner:latest' }) {
  const r = await _pool.query(
    'INSERT INTO bots (bot_username, bot_token, project_name, owner_chat_id, cpu_limit, mem_limit_mb, container_image) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [bot_username, bot_token, project_name, owner_chat_id, cpu_limit, mem_limit_mb, container_image]
  );
  return r.rows[0].id;
}

export async function setContainer(id, container_id) {
  await _pool.query('UPDATE bots SET container_id = $2 WHERE id = $1', [id, container_id]);
}

export async function setStatus(id, status, extra = {}) {
  const sets = ['status = $2'];
  const params = [id, status];
  if (extra.startedAt) { params.push(extra.startedAt); sets.push('last_started_at = $' + params.length); }
  if (extra.stoppedAt) { params.push(extra.stoppedAt); sets.push('last_stopped_at = $' + params.length); }
  if (extra.incrementRestart) sets.push('restart_count = restart_count + 1');
  await _pool.query('UPDATE bots SET ' + sets.join(', ') + ' WHERE id = $1', params);
}

export async function recordCrash(id, msg) {
  await _pool.query(
    "UPDATE bots SET crash_count = crash_count + 1, last_crash_at = NOW(), last_crash_msg = $2, status = 'crashed' WHERE id = $1",
    [id, String(msg).slice(0, 1000)]
  );
}
