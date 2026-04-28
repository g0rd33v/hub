#!/usr/bin/env bash
set -euo pipefail
systemctl enable --now cockpit.socket
# open firewall
if command -v ufw >/dev/null 2>&1; then
  ufw allow 9090/tcp || true
fi
