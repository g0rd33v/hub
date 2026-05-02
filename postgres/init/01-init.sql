-- Hub v0.4 — PostgreSQL initial schema
-- Runs automatically on first postgres container start

-- Create stage database
SELECT 'CREATE DATABASE hubdb_stage'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'hubdb_stage')\gexec

-- Projects table (replaces state.json)
CREATE TABLE IF NOT EXISTS projects (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    owner_chat_id TEXT,
    pap_token   TEXT UNIQUE,
    bot_token   TEXT,
    bot_username TEXT,
    github_repo TEXT,
    github_autosync BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- AAP tokens (agent access)
CREATE TABLE IF NOT EXISTS aaps (
    id          SERIAL PRIMARY KEY,
    project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    token       TEXT NOT NULL UNIQUE,
    branch      TEXT NOT NULL,
    revoked     BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- User KV store (replaces buffer SQLite)
CREATE TABLE IF NOT EXISTS user_kv (
    telegram_id TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (telegram_id, key)
);

-- Project KV store (replaces runtime/kv.sqlite)
CREATE TABLE IF NOT EXISTS project_kv (
    project_name TEXT NOT NULL,
    key          TEXT NOT NULL,
    value        BYTEA,
    expires_at   BIGINT,
    size         INTEGER,
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (project_name, key)
);

-- Analytics events
CREATE TABLE IF NOT EXISTS analytics_events (
    id          BIGSERIAL PRIMARY KEY,
    project     TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    path        TEXT,
    ip          TEXT,
    metadata    JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_chat_id);
CREATE INDEX IF NOT EXISTS idx_user_kv_tg ON user_kv(telegram_id);
CREATE INDEX IF NOT EXISTS idx_project_kv_name ON project_kv(project_name);
CREATE INDEX IF NOT EXISTS idx_analytics_project ON analytics_events(project, created_at);

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER user_kv_updated_at BEFORE UPDATE ON user_kv
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER project_kv_updated_at BEFORE UPDATE ON project_kv
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
