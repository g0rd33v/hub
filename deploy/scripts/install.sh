#!/bin/bash
set -e

echo "=== Hub v0.2 install ==="

# Directories
mkdir -p /var/lib/hub/projects /etc/hub /var/log/hub /var/backups/hub/daily /var/backups/hub/manual

# SAP token
if [ ! -f /etc/hub/sap.token ]; then
  openssl rand -hex 8 > /etc/hub/sap.token
  chmod 600 /etc/hub/sap.token
  echo "Generated SAP: $(cat /etc/hub/sap.token)"
fi

# hub.env
if [ ! -f /etc/hub/hub.env ]; then
  cat > /etc/hub/hub.env << EOF
NODE_ENV=production
SERVER_NUMBER=0
PUBLIC_BASE=https://hub.labs.co
HUB_PORT=3100
HUB_DATA_DIR=/var/lib/hub
HUB_CONFIG_DIR=/etc/hub
HUB_LOG_DIR=/var/log/hub
EOF
  chmod 600 /etc/hub/hub.env
fi

# npm install
cd /opt/hub && npm install --production

# nginx
if [ -f /opt/hub/deploy/nginx/hub.labs.co.conf ]; then
  ln -sf /opt/hub/deploy/nginx/hub.labs.co.conf /etc/nginx/sites-available/hub.labs.co
  ln -sf /etc/nginx/sites-available/hub.labs.co /etc/nginx/sites-enabled/hub.labs.co
  nginx -t && nginx -s reload
fi

# pm2
pm2 start /opt/hub/deploy/pm2/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "=== Install complete ==="
echo "SAP: $(cat /etc/hub/sap.token)"
echo "Test: curl http://localhost:3100/health"
