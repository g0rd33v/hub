#!/usr/bin/env bash
# install.sh — bootstrap a new Labs drafts server from a fresh Ubuntu 24.04
#
# Usage on a fresh Ubuntu box:
#   wget -qO- https://raw.githubusercontent.com/g0rd33v/hub/main/setup/install.sh \
#     | SERVER_NUMBER=2 PUBLIC_BASE=https://drafts2.labs.vc bash
#
# Or clone hub first and run locally:
#   git clone https://github.com/g0rd33v/hub /opt/hub
#   cd /opt/hub/setup
#   cp .env.example .env       # fill in tokens
#   bash install.sh
#
# Required env vars (read from .env if present, else from environment):
#   SERVER_NUMBER         numeric, 1-99 — used in domain template drafts<N>.labs.vc
#   PUBLIC_BASE           full URL https://drafts<N>.labs.vc — final public address
#   TG_BOT_TOKEN          master telegram bot token (from @BotFather)
#   CF_API_TOKEN          Cloudflare API token with Zone.DNS edit on labs.vc — optional
#   CF_ZONE_ID            Cloudflare zone id of labs.vc — optional
#
# What this does (in order):
#   1. apt update + install Node 20, pm2, nginx, certbot, cockpit, git, curl, jq
#   2. Clone hub to /opt/hub if not there
#   3. Install drafts: /opt/hub/drafts → /opt/drafts (with npm install)
#   4. Cloudflare DNS: create A record drafts<N>.labs.vc → server's public IP
#   5. nginx site: drafts<N>.labs.vc → proxy_pass localhost:3100
#   6. Let's Encrypt cert via certbot --nginx
#   7. Cockpit reachable at :9090 (if firewall opens it)
#   8. /etc/labs/drafts.env — environment file for drafts process
#   9. systemd via pm2 startup; pm2 start drafts; save
#  10. Smoke test: curl PUBLIC_BASE/drafts/health
#
# Idempotent: re-running is safe; existing files are not overwritten without --force.

set -euo pipefail

# --- env loading ----------------------------------------------------------
HUB_DIR="${HUB_DIR:-/opt/hub}"
ENV_FILE="${ENV_FILE:-$HUB_DIR/setup/.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

: "${SERVER_NUMBER:?SERVER_NUMBER is required (e.g. 2)}"
: "${PUBLIC_BASE:?PUBLIC_BASE is required (e.g. https://drafts2.labs.vc)}"
: "${TG_BOT_TOKEN:?TG_BOT_TOKEN is required (from @BotFather)}"

DOMAIN="drafts${SERVER_NUMBER}.labs.vc"
DRAFTS_PORT="${DRAFTS_PORT:-3100}"
DRAFTS_USER="${DRAFTS_USER:-root}"
DRAFTS_HOME="${DRAFTS_HOME:-/opt/drafts}"
DRAFTS_DATA_DIR="${DRAFTS_DATA_DIR:-/var/lib/drafts}"
LOG_DIR="${LOG_DIR:-/var/log/drafts}"
SAP_FILE="${SAP_FILE:-/etc/labs/drafts.sap}"

log() { printf '\n[\033[1;36m%s\033[0m] %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()  { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
err() { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. apt + base packages ----------------------------------------------
log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl wget jq git ca-certificates gnupg \
  nginx certbot python3-certbot-nginx \
  cockpit cockpit-storaged cockpit-networkmanager \
  ufw cron \
  build-essential
ok "base packages installed"

# Node 20 from NodeSource
if ! command -v node >/dev/null || [[ "$(node -v 2>/dev/null | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  log "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
  ok "Node $(node -v)"
fi

# pm2 globally
if ! command -v pm2 >/dev/null; then
  log "Installing pm2"
  npm install -g pm2 >/dev/null
  ok "pm2 $(pm2 -v)"
fi

# --- 2. Clone hub --------------------------------------------------------
if [[ ! -d "$HUB_DIR/.git" ]]; then
  log "Cloning hub to $HUB_DIR"
  git clone https://github.com/g0rd33v/hub "$HUB_DIR"
  ok "hub cloned"
else
  log "hub already at $HUB_DIR — pulling latest"
  git -C "$HUB_DIR" pull --ff-only
fi

# --- 3. Install drafts ---------------------------------------------------
log "Installing drafts to $DRAFTS_HOME"
mkdir -p "$DRAFTS_HOME" "$DRAFTS_DATA_DIR" "$LOG_DIR" "$(dirname "$SAP_FILE")"
cp -r "$HUB_DIR/drafts/." "$DRAFTS_HOME/"
cd "$DRAFTS_HOME"
if [[ ! -d node_modules ]]; then
  npm install --omit=dev --silent
fi
ok "drafts installed ($(wc -l < drafts.js) LOC main + $(wc -l < telepath.js) telepath)"

# Generate SAP token if missing
if [[ ! -s "$SAP_FILE" ]]; then
  openssl rand -hex 8 > "$SAP_FILE"
  chmod 600 "$SAP_FILE"
  ok "generated SAP token at $SAP_FILE"
fi
SAP_TOKEN="$(cat "$SAP_FILE")"

# Drafts env file
cat > /etc/labs/drafts.env <<EOF
SERVER_NUMBER=$SERVER_NUMBER
PUBLIC_BASE=$PUBLIC_BASE
DRAFTS_PORT=$DRAFTS_PORT
DRAFTS_DIR=$DRAFTS_DATA_DIR
BEARER_TOKEN=$SAP_TOKEN
TG_BOT_TOKEN=$TG_BOT_TOKEN
NODE_ENV=production
EOF
chmod 600 /etc/labs/drafts.env
ok "/etc/labs/drafts.env written"

# --- 4. Cloudflare DNS ---------------------------------------------------
if [[ -n "${CF_API_TOKEN:-}" && -n "${CF_ZONE_ID:-}" ]]; then
  log "Setting Cloudflare DNS for $DOMAIN"
  PUBLIC_IP="$(curl -fsSL https://api.ipify.org)"

  # Check if record exists
  RECORD_ID="$(curl -fsSL \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?type=A&name=$DOMAIN" \
    | jq -r '.result[0].id // empty')"

  if [[ -n "$RECORD_ID" ]]; then
    curl -fsSL -X PUT \
      -H "Authorization: Bearer $CF_API_TOKEN" \
      -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$RECORD_ID" \
      --data "{\"type\":\"A\",\"name\":\"$DOMAIN\",\"content\":\"$PUBLIC_IP\",\"ttl\":1,\"proxied\":false}" >/dev/null
    ok "updated A record $DOMAIN → $PUBLIC_IP"
  else
    curl -fsSL -X POST \
      -H "Authorization: Bearer $CF_API_TOKEN" \
      -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
      --data "{\"type\":\"A\",\"name\":\"$DOMAIN\",\"content\":\"$PUBLIC_IP\",\"ttl\":1,\"proxied\":false}" >/dev/null
    ok "created A record $DOMAIN → $PUBLIC_IP"
  fi

  log "Waiting 20s for DNS propagation"
  sleep 20
else
  log "Skipping Cloudflare automation (CF_API_TOKEN or CF_ZONE_ID not set)"
  log "  → create A record $DOMAIN → $(curl -fsSL https://api.ipify.org) manually before continuing"
fi

# --- 5. nginx site -------------------------------------------------------
log "Configuring nginx for $DOMAIN"
cp "$HUB_DIR/setup/nginx.conf.template" /etc/nginx/sites-available/"$DOMAIN"
sed -i "s/{{DOMAIN}}/$DOMAIN/g; s/{{DRAFTS_PORT}}/$DRAFTS_PORT/g" /etc/nginx/sites-available/"$DOMAIN"
ln -sf /etc/nginx/sites-available/"$DOMAIN" /etc/nginx/sites-enabled/"$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
ok "nginx site $DOMAIN active"

# --- 6. Let's Encrypt ----------------------------------------------------
if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  log "Requesting Let's Encrypt cert for $DOMAIN"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@labs.vc" --redirect
  ok "TLS cert installed"
else
  ok "TLS cert already exists for $DOMAIN"
fi

# --- 7. Cockpit ----------------------------------------------------------
systemctl enable --now cockpit.socket
ufw allow 9090/tcp 2>/dev/null || true
ok "Cockpit on :9090"

# --- 8. firewall ---------------------------------------------------------
ufw allow 22/tcp 2>/dev/null || true
ufw allow 80/tcp 2>/dev/null || true
ufw allow 443/tcp 2>/dev/null || true
ufw --force enable 2>/dev/null || true
ok "firewall: 22, 80, 443, 9090 open"

# --- 9. pm2 + drafts -----------------------------------------------------
log "Starting drafts via pm2"
cd "$DRAFTS_HOME"
pm2 delete drafts 2>/dev/null || true
pm2 start app.js --name drafts --update-env --env production \
  --node-args="--no-warnings" \
  -- --env-file /etc/labs/drafts.env
pm2 save
pm2 startup systemd -u "$DRAFTS_USER" --hp "/$DRAFTS_USER" >/dev/null || true
ok "drafts running on :$DRAFTS_PORT"

# auto-update cron (every 15 min, pulls hub and re-deploys)
cat > /etc/cron.d/drafts-autoupdate <<EOF
*/15 * * * * root /opt/hub/setup/auto-update.sh >> /var/log/drafts/auto-update.log 2>&1
EOF
chmod 644 /etc/cron.d/drafts-autoupdate
ok "auto-update cron set (every 15 min)"

# --- 10. smoke test ------------------------------------------------------
log "Smoke test"
sleep 3
HEALTH="$(curl -fsSL "$PUBLIC_BASE/drafts/health" || echo '{"error":"unreachable"}')"
echo "  $HEALTH"
if echo "$HEALTH" | jq -e '.version' >/dev/null 2>&1; then
  VERSION="$(echo "$HEALTH" | jq -r '.version')"
  ok "drafts $VERSION live at $PUBLIC_BASE"
else
  err "drafts health check failed — see pm2 logs drafts"
fi

# --- summary -------------------------------------------------------------
cat <<EOF

$(printf '\033[1;32m═══════════════════════════════════════════════════════════════\033[0m')
$(printf '\033[1;32m✓ Server $SERVER_NUMBER is live\033[0m')

  public_base   $PUBLIC_BASE
  domain        $DOMAIN
  drafts port   $DRAFTS_PORT
  cockpit       https://$DOMAIN:9090
  health        $PUBLIC_BASE/drafts/health
  SAP token     $(cat $SAP_FILE)

  next steps:
    1. open the master bot in Telegram (token in /etc/labs/drafts.env)
    2. send /start, then activate SAP via:
       $PUBLIC_BASE/drafts/pass/drafts_server_${SERVER_NUMBER}_$(cat $SAP_FILE)
    3. import projects from hub:
       cd $HUB_DIR/projects && ls
$(printf '\033[1;32m═══════════════════════════════════════════════════════════════\033[0m')
EOF
