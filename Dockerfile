# Hub v0.4 — Node.js container
# Multi-stage build for smaller image

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app

# Security: non-root user
RUN addgroup -g 1001 -S hubgroup && \
    adduser -u 1001 -S hubuser -G hubgroup

# Copy deps and app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=hubuser:hubgroup . .

# Runtime dirs
RUN mkdir -p /var/lib/hub /var/log/hub /etc/hub && \
    chown -R hubuser:hubgroup /var/lib/hub /var/log/hub

USER hubuser

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3100/health || exit 1

CMD ["node", "hub/server.js"]
