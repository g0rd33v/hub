# Hub Changelog

## v0.5.0 — 2026-05-02 — Security hardening + ops improvements

### Critical security fixes

- **Sandbox**: removed `Buffer` from safe globals. The VM escape pattern
  `Buffer.from('').constructor.constructor('return process')()` previously
  returned the parent realm `process` object, giving user code in projects
  full access to environment, files, and the ability to kill the server.
  (`modules/runtime/sandbox.js`)

- **Sandbox**: wrapped `fetch` with SSRF protection. Blocks requests to
  private IP ranges (`10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`,
  IPv6 loopback/ULA/link-local) by resolving DNS first and failing if any
  resolved address is private. Default 15s timeout if caller doesn't set one.
  Only `http(s)` protocols allowed. (`modules/runtime/sandbox.js`)

- **SAP comparison**: replaced `===` with `crypto.timingSafeEqual` via the
  new `safeEq()` helper. Previous code leaked SAP bytes via timing.
  (`hub/credentials.js`)

- **Token entropy**: bumped all tier tokens to 16 bytes (128 bits).
  Previously SAP=8B (64 bits), PAP=6B (48 bits), AAP=5B (40 bits) — AAP was
  brute-forceable in hours on a single core. (`hub/credentials.js`)

- **SAP secret no longer leaked to logs**: `loadServerSAP()` previously
  printed the SAP token to stdout when minting, which surfaced in PM2 log
  files readable by anyone with root. Now displayed only on TTY (when
  `process.stdout.isTTY`), and never written to log streams.
  (`hub/credentials.js`)

### High-priority improvements

- **Graceful shutdown**: SIGTERM / SIGINT trigger `server.close()` and a
  500ms drain before `process.exit(0)`. Hard kill at 10s if drain stalls.
  Added `uncaughtException` and `unhandledRejection` loggers.
  (`hub/server.js`)

- **Module loader resilience**: each module loads in `try/catch`. A single
  module failing now degrades gracefully (logs error, continues without it)
  instead of crashing the entire kernel boot. (`hub/server.js`)

- **Memory leak fix**: `credentials.js` rate-limit `hits` Map now has a
  periodic cleanup (every 10 min, drops entries older than 24h) that runs
  via `setInterval(...).unref()`. Previously, the Map grew without bound.
  (`hub/credentials.js`)

- **Request logging middleware**: assigns a request id, logs only `4xx`/`5xx`
  responses or requests slower than 1 second. Keeps log noise low while
  capturing what matters for postmortem. (`hub/server.js`)

### Other changes

- Bumped version `0.2.0` → `0.5.0`
- `express.json({ limit: '1mb' })` — was 10MB (DoS hardening)
- Synced production server's manual edits into source: `app.set('trust proxy', 1)`,
  `app.listen('0.0.0.0', ...)`, status routes (`/status/<slug>`,
  `/status/<slug>/stage-health`, `/status/<slug>/infra`)

### Known issues / planned for v0.6+

These require larger rewrites and were not included in v0.5:

- **vm.Script timeout is sync-only.** Async user code (`await`, `Promise`,
  `setTimeout`, `queueMicrotask`) bypasses the 1s timeout. Project scripts
  can spin the event loop indefinitely. Needs Worker thread isolation with
  real kill-switch.

- **`master.js` decomposition.** The Telegram bot dispatcher is a 760-line
  monolith. The recent `getBase` nested-function bug shipped because there
  are no tests. Plan: split into `commands/`, `keyboards.js`, `helpers.js`.

- **`/buffer/:telegramId` HMAC auth.** Anyone who knows a user's Telegram ID
  can read their full buffer. Plan: HMAC-signed URLs from the bot, validated
  server-side. Requires bot-side changes.

- **Postgres migration not finished.** v0.4 stood up the database but Hub
  still uses `state.json` + per-user SQLite files. Migration script exists
  (`scripts/migrate-state.mjs`) but hasn't been wired in yet.

- **Off-server backups.** Backups currently land in `/root/backups/` only.
  Need rclone/restic to S3/B2/Hetzner Storage Box.

- **No CI/CD.** Every deploy is a manual `pm2 restart` via Cockpit terminal.

## v0.4 — 2026-05-02 — Docker stack

- Docker Engine 29.4.2 + Compose 5.1.3
- PostgreSQL 16 in container with 5 tables (projects, aaps, user_kv,
  project_kv, analytics_events) — schema staged, migration pending
- Nginx in container, ports 80/443
- Let's Encrypt SSL for `hub.labs.co` (auto-renew via cron)
- Fail2Ban (sshd, nginx-http-auth, nginx-limit-req)
- Watchtower (monitor-only mode)
- Daily backup cron, autostart on reboot
- iptables rules to allow Docker bridge → host port 3100/3101

## v0.3 — 2026-04 — Kernel + module split

- Split monolith `drafts/` server into kernel + modules
- Module structure: `buffer`, `runtime`, `drafts`, `telegram`, `analytics`, `wizard`
- Status page at secret slug (`/status/<slug>`)
- Telegram language picker (6 langs)
- `/stage` toggle for testing on `stage.hub.labs.co`
- i18n module (partial — ~5% of strings translated)
