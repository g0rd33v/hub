#!/usr/bin/env bash
set -euo pipefail
DOMAIN="${1:?usage: letsencrypt.sh <domain>}"
EMAIL="${ADMIN_EMAIL:-admin@labs.vc}"
certbot --nginx -d "${DOMAIN}" -m "${EMAIL}" --agree-tos -n --redirect
