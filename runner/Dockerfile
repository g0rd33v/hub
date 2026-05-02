# hub-bot-runner v0.5.0
# Minimal isolated container runtime for a single Telegram bot.
#
# Build: docker build -t hub-bot-runner:v0.5 -t hub-bot-runner:latest .
# Run via orchestrator (botctl) with strict resource limits — see README.md.

FROM node:20-alpine

WORKDIR /app

# Non-root user (uid 1001) — user code never runs as root
RUN addgroup -g 1001 -S botgroup && \
    adduser -u 1001 -S botuser -G botgroup

# Copy runner code (zero npm dependencies, so no `npm install`)
COPY --chown=botuser:botgroup runner.js package.json ./

# User code mount point — empty in image, mounted read-only at runtime
RUN mkdir -p /app/user && chown botuser:botgroup /app/user

USER botuser

# No HEALTHCHECK — the orchestrator monitors via `docker ps` + stderr stream.
# Adding pgrep would require installing procps (~270KB) for marginal benefit.

CMD ["node", "/app/runner.js"]
