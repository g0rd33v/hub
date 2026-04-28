#!/usr/bin/env bash
# auto-update.sh — pull latest hub and re-deploy drafts if changed
# Runs every 15 minutes via /etc/cron.d/drafts-autoupdate

set -euo pipefail

HUB_DIR="${HUB_DIR:-/opt/hub}"
DRAFTS_HOME="${DRAFTS_HOME:-/opt/drafts}"

cd "$HUB_DIR"
BEFORE="$(git rev-parse HEAD)"
git pull --ff-only --quiet 2>/dev/null || exit 0
AFTER="$(git rev-parse HEAD)"

if [[ "$BEFORE" == "$AFTER" ]]; then
  exit 0
fi

# Hub changed — check if drafts subtree was touched
if git diff --name-only "$BEFORE" "$AFTER" | grep -q '^drafts/'; then
  echo "[$(date)] drafts/ changed: $BEFORE..$AFTER → redeploying"
  cp -ru "$HUB_DIR/drafts/." "$DRAFTS_HOME/"
  cd "$DRAFTS_HOME"
  npm install --omit=dev --silent 2>/dev/null || true
  pm2 restart drafts >/dev/null
  echo "[$(date)] drafts restarted"
else
  echo "[$(date)] hub updated but drafts/ unchanged — no restart"
fi
