#!/bin/bash
# Hub v0.4 — Migrate state.json + SQLite KV → PostgreSQL
# Run ONCE after postgres is up, BEFORE stopping PM2

set -e

PG_CONTAINER=hub-postgres
PG_USER=${POSTGRES_USER:-hubuser}
PG_DB=${POSTGRES_DB:-hubdb}

echo "[migrate] Starting SQLite → PostgreSQL migration"

# 1. Migrate state.json → projects table
if [ -f /var/lib/hub/state.json ]; then
    echo "[migrate] Importing state.json..."
    node /opt/hub-v04/scripts/migrate-state.mjs
    echo "[migrate] state.json imported"
fi

# 2. Migrate user KV (buffer)
if [ -d /var/lib/hub/buffer ]; then
    echo "[migrate] Importing user KV..."
    node /opt/hub-v04/scripts/migrate-kv.mjs
    echo "[migrate] user KV imported"
fi

echo "[migrate] Done. Verify with:"
echo "  docker exec hub-postgres psql -U $PG_USER -d $PG_DB -c 'SELECT name FROM projects;'"
