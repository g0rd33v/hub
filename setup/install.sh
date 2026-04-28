#!/usr/bin/env bash
# hub setup - bring a fresh Ubuntu 24 box from zero to a running drafts server
# usage:
#   1. provision Ubuntu 24.04, get root
#   2. apt update && apt install -y git
#   3. git clone https://github.com/g0rd33v/hub.git /opt/hub
#   4. cd /opt/hub/setup
#   5. cp env.example .env && edit .env
#   6. ./install.sh
set -euo pipefail

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "[FATAL] $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "run as root"
[[ -f .env ]] || fail "copy env.example to .env and fill it in first"
set -a
. ./.env
set +a

: "${SERVER_NUMBER:?must set SERVER_NUMBER (1, 2, ...)}"
: "${TG_BOT_TOKEN:?must set TG_BOT_TOKEN (master telepath bot)}"
: "${CF_API_TOKEN:?must set CF_API_TOKEN (Cloudflare API)}"
: "${CF_ZONE_ID:?must set CF_ZONE_ID (zone of labs.vc)}"

DOMAIN="drafts${SERVER_NUMBER}.labs.vc"
PUBLIC_BASE="https://${DOMAIN}"
log "target domain: ${DOMAIN}"

log "step 1/10 :: installing system packages"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates gnupg lsb-release nginx certbot python3-certbot-nginx cockpit jq git

log "step 2/10 :: installing Node 20 + pm2"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
npm install -g --silent pm2

log "step 3/10 :: copying drafts source from hub repo to /opt/drafts"
HUB_DIR="$(cd .. && pwd)"
mkdir -p /opt/drafts /var/lib/drafts /etc/labs
rsync -a --delete "${HUB_DIR}/drafts/" /opt/drafts/
cd /opt/drafts && npm ci --omit=dev --silent

log "step 4/10 :: copying drafts-projects (wizapp, buffer)"
for proj in wizapp buffer; do
  mkdir -p "/var/lib/drafts/${proj}/live"
  rsync -a "${HUB_DIR}/projects/${proj}/" "/var/lib/drafts/${proj}/live/"
done

log "step 5/10 :: writing drafts.env"
cat > /opt/drafts/.env <<DENV
SERVER_NUMBER=${SERVER_NUMBER}
PUBLIC_BASE=${PUBLIC_BASE}
TG_BOT_TOKEN=${TG_BOT_TOKEN}
DRAFTS_DIR=/var/lib/drafts
PORT=3100
DENV

log "step 6/10 :: provisioning DNS via Cloudflare"
bash ./cloudflare.sh "${DOMAIN}"

log "step 7/10 :: rendering nginx config and reloading"
sed "s/{{DOMAIN}}/${DOMAIN}/g" nginx.conf.template > "/etc/nginx/sites-available/${DOMAIN}"
ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "step 8/10 :: issuing Let's Encrypt certificate"
bash ./letsencrypt.sh "${DOMAIN}"

log "step 9/10 :: opening Cockpit on :9090"
bash ./cockpit.sh

log "step 10/10 :: starting drafts under pm2"
cd /opt/drafts
pm2 delete drafts >/dev/null 2>&1 || true
pm2 start drafts.js --name drafts --time
pm2 save
pm2 startup systemd -u root --hp /root | tail -n1 | bash || true

log ""
log "=== install complete ==="
log "domain  : ${PUBLIC_BASE}"
log "cockpit : https://${DOMAIN}:9090"
log ""
log "next: send /start to your master telepath bot"
log "the bot will print a SAP activation pass-link."
log "open it once, paste it back into the bot to bind yourself as SAP."
