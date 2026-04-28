#!/bin/bash
# drafts-backup  snapshot + rotate. runs hourly via cron.
# Usage:  /opt/drafts/scripts/backup.sh hourly|daily
set -euo pipefail

KIND="${1:-hourly}"
BACKUP_ROOT="/var/backups/drafts"
DRAFTS_DIR="/var/lib/drafts"
ETC_DIR="/etc/labs"
CODE_DIR="/opt/drafts"

if [[ "$KIND" != "hourly" && "$KIND" != "daily" ]]; then
  echo "usage: $0 hourly|daily"; exit 1
fi

DEST="$BACKUP_ROOT/$KIND"
mkdir -p "$DEST"

TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
OUT="$DEST/snapshot-$TS.tar.gz"

# Build tarball: state, telepath, all project data, env, code (excluding node_modules)
tar czf "$OUT" \
  --exclude="$CODE_DIR/node_modules" \
  --exclude="$CODE_DIR/*.bak" \
  -C / \
  "${DRAFTS_DIR#/}" \
  "${ETC_DIR#/}" \
  "${CODE_DIR#/}" \
  2>/dev/null || { echo "tar failed"; exit 1; }

SIZE=$(du -h "$OUT" | cut -f1)
echo "[backup] $KIND snapshot OK: $OUT ($SIZE)"

# Rotate: keep last N
if [[ "$KIND" == "hourly" ]]; then KEEP=24; else KEEP=30; fi

ls -1t "$DEST"/snapshot-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

REMAINING=$(ls -1 "$DEST"/snapshot-*.tar.gz 2>/dev/null | wc -l)
echo "[backup] $KIND retention: $REMAINING/$KEEP snapshots kept"

# Notify Telegram (best-effort)
if [[ -f /etc/labs/telegram.token ]] && [[ -n "${BACKUP_NOTIFY_CHAT:-}" ]]; then
  TOKEN=$(cat /etc/labs/telegram.token | tr -d '\n')
  curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
    -d "chat_id=$BACKUP_NOTIFY_CHAT" \
    -d "parse_mode=HTML" \
    -d "text= <b>$KIND backup OK</b>%0A$(basename $OUT)%0A$SIZE  $REMAINING/$KEEP kept" \
    > /dev/null || true
fi
