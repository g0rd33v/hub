#!/usr/bin/env bash
# Create or update an A record on Cloudflare for $1 -> public IP of this box.
set -euo pipefail
: "${CF_API_TOKEN:?}"
: "${CF_ZONE_ID:?}"
DOMAIN="${1:?usage: cloudflare.sh <domain>}"
IP="$(curl -fsS https://api.ipify.org)"
echo "  cloudflare: ${DOMAIN} -> ${IP}"

AUTH=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")
API="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}"

# look for existing record
EXISTING=$(curl -fsS "${AUTH[@]}" "${API}/dns_records?type=A&name=${DOMAIN}" | jq -r '.result[0].id // empty')

if [[ -n "${EXISTING}" ]]; then
  curl -fsS -X PATCH "${AUTH[@]}" "${API}/dns_records/${EXISTING}" \
    -d "{\"type\":\"A\",\"name\":\"${DOMAIN}\",\"content\":\"${IP}\",\"ttl\":120,\"proxied\":false}" | jq -r '.success'
else
  curl -fsS -X POST "${AUTH[@]}" "${API}/dns_records" \
    -d "{\"type\":\"A\",\"name\":\"${DOMAIN}\",\"content\":\"${IP}\",\"ttl\":120,\"proxied\":false}" | jq -r '.success'
fi

echo "  waiting 8s for DNS to propagate ..."
sleep 8
