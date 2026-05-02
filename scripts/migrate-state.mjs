// Hub v0.4 — Migrate state.json to PostgreSQL
import { readFileSync } from 'fs';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const state = JSON.parse(readFileSync('/var/lib/hub/state.json', 'utf8'));
  const projects = state.projects || [];

  for (const p of projects) {
    await pool.query(
      `INSERT INTO projects (name, description, owner_chat_id, pap_token, bot_token, bot_username, github_repo, github_autosync)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (name) DO UPDATE SET
         description = EXCLUDED.description,
         owner_chat_id = EXCLUDED.owner_chat_id,
         pap_token = EXCLUDED.pap_token,
         bot_token = EXCLUDED.bot_token,
         bot_username = EXCLUDED.bot_username`,
      [
        p.name,
        p.description || null,
        p.owner_chat_id || null,
        p.pap?.token || null,
        p.bot?.token || null,
        p.bot?.bot_username || null,
        p.github_repo || null,
        p.github_autosync || false,
      ]
    );
    console.log(`[migrate] project: ${p.name}`);
  }
  console.log(`[migrate] ${projects.length} projects imported`);
} finally {
  await pool.end();
}
