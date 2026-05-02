#!/bin/bash
# Hub v0.4 — Deploy script
# Usage: ./scripts/deploy.sh [prod|stage]

set -e

ENV=${1:-prod}
VERSION=$(git describe --tags --always 2>/dev/null || echo 'dev')

echo "[deploy] Hub v0.4 — env=$ENV version=$VERSION"

cd /opt/hub-v04

# Pull latest code
git pull origin v0.4

# Build image with version tag
docker build -t hub:$VERSION -t hub:latest .

if [ "$ENV" = "prod" ]; then
    docker compose up -d hub nginx
    echo "[deploy] prod updated"
elif [ "$ENV" = "stage" ]; then
    docker compose up -d hub-stage
    echo "[deploy] stage updated"
fi

docker compose ps
