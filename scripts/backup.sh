#!/bin/bash
# Hub v0.4 — Daily backup script
# Cron: 0 3 * * * /opt/hub-v04/scripts/backup.sh >> /var/log/hub/backup.log 2>&1

set -e

DATE=$(date +%Y-%m-%d)
BACKUP_DIR=/root/backups/$DATE
mkdir -p "$BACKUP_DIR"

echo "[backup] Starting $DATE"

# PostgreSQL dump
docker exec hub-postgres pg_dumpall -U hubuser > "$BACKUP_DIR/postgres-all.sql" && \
    echo "[backup] postgres OK"

# Hub data volumes
docker run --rm \
    -v hub-v04_hub_data:/source/hub_data:ro \
    -v hub-v04_hub_stage_data:/source/hub_stage_data:ro \
    -v hub-v04_hub_config:/source/hub_config:ro \
    -v "$BACKUP_DIR":/backup \
    alpine tar czf /backup/volumes.tar.gz -C /source . && \
    echo "[backup] volumes OK"

# Cleanup: keep 30 days
find /root/backups -maxdepth 1 -type d -name '20*' | sort | head -n -30 | xargs rm -rf

echo "[backup] Done: $BACKUP_DIR"
ls -lh "$BACKUP_DIR"
