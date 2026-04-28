#!/usr/bin/env bash
# install.sh  bootstrap a hub instance from a fresh Ubuntu 24.04 box
#
# Quickstart (uses defaults: DOMAIN=hub.labs.co):
#   git clone https://github.com/g0rd33v/hub /opt/hub
#   cd /opt/hub/setup
#   cp .env.example .env       # set TG_BOT_TOKEN at minimum
#   bash install.sh
#
# Custom domain:
#   DOMAIN=mydraft.example.com TG_BOT_TOKEN=... bash install.sh
#
# Required env (read from .env if present):
#   TG_BOT_TOKEN          master telegram bot token (from @BotFather)
#
# Optional env (sensible defaults):
#   DOMAIN                public hostname  (default: hub.labs.co)
#   PUBLIC_BASE           full URL         (default: https://$DOMAIN)
#   EMAIL                 LE registration  (default: admin@$DOMAIN)
#   SERVER_NUMBER         federation id    (default: 0)
#   DRAFTS_PORT           backend port     (default: 3100)
#   CF_API_TOKEN          Cloudflare token  enables auto DNS
#   CF_ZONE_ID            Cloudflare zone id
#
# Idempotent. Safe to re-run.

set -euo pipefail

HUB_DIR="${HUB_DIR:-/opt/hub}"
ENV_FILE="${ENV_FILE:-$HUB_DIR/setup/.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; source "$ENV_FILE"; set +a; fi

DOMAIN="${DOMAIN:-hub.labs.co}"
PUBLIC_BASE="${PUBLIC_BASE:-https://$DOMAIN}"
EMAIL="${EMAIL:-admin@$DOMAIN}"
SERVER_NUMBER="${SERVER_NUMBER:-0}"
DRAFTS_PORT="${DRAFTS_PORT:-3100}"
DRAFTS_USER="${DRAFTS_USER:-root}"
DRAFTS_HOME="${DRAFTS_HOME:-/opt/drafts}"
DRAFTS_DATA_DIR="${DRAFTS_DATA_DIR:-/var/lib/drafts}"
LOG_DIR="${LOG_DIR:-/var/log/drafts}"
SAP_FILE="${SAP_FILE:-/etc/labs/drafts.sap}"

: "${TG_BOT_TOKEN:?TG_BOT_TOKEN is required (from @BotFather)}"

log() { printf '\n[\033[1;36m%s\033[0m] %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()  { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
err() { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

log "Bootstrapping hub on $DOMAIN (server #$SERVER_NUMBER)"

# 1. base packages
log "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl wget jq git ca-certificates gnupg \
  nginx certbot python3-certbot-nginx \
  cockpit cockpit-storaged cockpit-networkmanager \
  ufw cron build-essential
ok "base packages installed"

if ! command -v node >/dev/null || [[ "$(node -v 2>/dev/null | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  log "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
  ok "Node $(node -v)"
fi

if ! command -v pm2 >/dev/null; then
  log "Installing pm2"
  npm install -g pm2 >/dev/null
  ok "pm2 $(pm2 -v)"
fi

# 2. Hub repo
if [[ ! -d "$HUB_DIR/.git" ]]; then
  log "Cloning hub to $HUB_DIR"
  git clone https://github.com/g0rd33v/hub "$HUB_DIR"
  ok "hub cloned"
else
  log "hub already at $HUB_DIR — fetching latest"
  git -C "$HUB_DIR" fetch --quiet origin && git -C "$HUB_DIR" pull --ff-only --quiet || log "  (skipping pull — working dir not clean or detached HEAD)"
fi

# 3. drafts runtime
log "Installing drafts runtime to $DRAFTS_HOME"
mkdir -p "$DRAFTS_HOME" "$DRAFTS_DATA_DIR" "$LOG_DIR" "$(dirname "$SAP_FILE")"
cp -r "$HUB_DIR/drafts/." "$DRAFTS_HOME/"
cd "$DRAFTS_HOME"
if [[ ! -d node_modules ]]; then npm install --omit=dev --silent; fi
ok "drafts installed ($(wc -l < drafts.js 2>/dev/null || echo ?) LOC drafts.js + $(wc -l < telepath.js 2>/dev/null || echo ?) telepath)"

# 4. SAP
if [[ ! -s "$SAP_FILE" ]]; then
  openssl rand -hex 8 > "$SAP_FILE"
  chmod 600 "$SAP_FILE"
  ok "generated SAP token at $SAP_FILE"
fi
SAP_TOKEN="$(cat "$SAP_FILE")"

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

# 5. Cloudflare DNS (optional)
if [[ -n "${CF_API_TOKEN:-}" && -n "${CF_ZONE_ID:-}" ]]; then
  log "Setting Cloudflare DNS for $DOMAIN"
  PUBLIC_IP="$(curl -fsSL https://api.ipify.org)"
  RECORD_ID="$(curl -fsSL -H "Authorization: Bearer $CF_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?type=A&name=$DOMAIN" | jq -r '.result[0].id // empty')"
  if [[ -n "$RECORD_ID" ]]; then
    curl -fsSL -X PUT -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$RECORD_ID" \
      --data "{\"type\":\"A\",\"name\":\"$DOMAIN\",\"content\":\"$PUBLIC_IP\",\"ttl\":1,\"proxied\":false}" >/dev/null
    ok "updated A record $DOMAIN → $PUBLIC_IP"
  else
    curl -fsSL -X POST -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
      --data "{\"type\":\"A\",\"name\":\"$DOMAIN\",\"content\":\"$PUBLIC_IP\",\"ttl\":1,\"proxied\":false}" >/dev/null
    ok "created A record $DOMAIN → $PUBLIC_IP"
  fi
  log "Waiting 20s for DNS propagation"; sleep 20
else
  log "Skipping Cloudflare automation (CF_API_TOKEN/CF_ZONE_ID not set)"
  log "  expecting A record $DOMAIN → $(curl -fsSL https://api.ipify.org) is already set"
fi

# 6. nginx
log "Configuring nginx for $DOMAIN"
cp "$HUB_DIR/setup/nginx.conf.template" /etc/nginx/sites-available/"$DOMAIN"
sed -i "s/{{DOMAIN}}/$DOMAIN/g; s/{{DRAFTS_PORT}}/$DRAFTS_PORT/g" /etc/nginx/sites-available/"$DOMAIN"
ln -sf /etc/nginx/sites-available/"$DOMAIN" /etc/nginx/sites-enabled/"$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
ok "nginx site $DOMAIN active"

# 7. TLS
if [[ ! -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
  log "Requesting Let's Encrypt cert for $DOMAIN"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
  ok "TLS cert installed"
else
  ok "TLS cert already exists for $DOMAIN"
fi

# 8. Cockpit + firewall
systemctl enable --now cockpit.socket
ufw allow 9090/tcp 2>/dev/null || true
ufw allow 22/tcp 2>/dev/null || true
ufw allow 80/tcp 2>/dev/null || true
ufw allow 443/tcp 2>/dev/null || true
ufw --force enable 2>/dev/null || true
ok "firewall: 22, 80, 443, 9090 open"

# 9. pm2 + drafts
log "Starting drafts via pm2"
cd "$DRAFTS_HOME"
pm2 delete drafts 2>/dev/null || true
pm2 start app.js --name drafts --update-env --env production --node-args="--no-warnings" -- --env-file /etc/labs/drafts.env
pm2 save
pm2 startup systemd -u "$DRAFTS_USER" --hp "/$DRAFTS_USER" >/dev/null || true
ok "drafts running on :$DRAFTS_PORT"

cat > /etc/cron.d/drafts-autoupdate <<EOF
*/15 * * * * root /opt/hub/setup/auto-update.sh >> /var/log/drafts/auto-update.log 2>&1
EOF
chmod 644 /etc/cron.d/drafts-autoupdate
ok "auto-update cron set (every 15 min)"

# 10. smoke
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

echo
echo "═════════════════════════════════════════"
echo "hub instance live"
echo "  domain        $DOMAIN"
echo "  public_base   $PUBLIC_BASE"
echo "  cockpit       https://$DOMAIN:9090"
echo "  health        $PUBLIC_BASE/drafts/health"
echo "  SAP token     $(cat $SAP_FILE)"
echo
echo "next:"
echo "  1. open the master bot in Telegram (token in /etc/labs/drafts.env)"
echo "  2. activate SAP via:  $PUBLIC_BASE/signin/pass_${SERVER_NUMBER}_server_$(cat $SAP_FILE)"
echo "  3. import projects:   cd $HUB_DIR/projects && ls"
