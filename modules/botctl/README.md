# botctl — Hub bot orchestrator

Manages per-bot Docker containers. One container per Telegram bot, with strict
resource limits. The Hub backend is the only thing that talks to the Docker
socket — users never get host access.

## Submodules

| File          | Responsibility |
|---------------|----------------|
| `docker.js`   | Thin wrapper over Docker Engine API via `/var/run/docker.sock`. Zero deps. |
| `db.js`       | Postgres client for the `bots` table. Uses `pg` connection pool. |
| `lifecycle.js`| High-level ops: `spawn / stop / restart / getStatus / tailLogs / listManagedContainers`. Always validates bot id against DB. |
| `index.js`    | Module entry. Inits docker + db, mounts read-only HTTP routes under SAP. |

## HTTP endpoints (all under SAP auth)

| Method | Path                              | Returns |
|--------|-----------------------------------|---------|
| GET    | `/hub/botctl/ping`                | Docker version info if socket reachable |
| GET    | `/hub/botctl/bots`                | All bot rows (token redacted). Filter via `?status=`, `?owner=`, `?project=` |
| GET    | `/hub/botctl/containers`          | Hub-managed Docker containers (label `hub.managed=true`) |
| GET    | `/hub/botctl/bots/:id/status`     | DB row + live `docker inspect` |
| GET    | `/hub/botctl/bots/:id/logs?n=100` | Demuxed container stdout/stderr, last `n` lines |

Mutating endpoints (spawn / stop / restart / remove) ship in step 7 alongside
the Telegram UI commands.

## Container security defaults

Applied at `docker run` time by `lifecycle.spawn()`:

- Resource limits **from DB**, not from caller (`bot.cpu_limit`, `bot.mem_limit_mb`)
- `--cap-drop=ALL` — no Linux capabilities
- `--read-only` — root filesystem is immutable
- `--tmpfs /tmp` (64MB, noexec, nosuid)
- `--pids-limit=128` — fork-bomb protection
- `--restart=unless-stopped`
- `--log-driver=json-file --log-opt max-size=10m --log-opt max-file=3` (30MB log cap per bot)
- User code mounted **read-only** at `/app/user:ro`
- Container runs as `botuser` (uid 1001), set by the image

## DATABASE_URL resolution order

1. `process.env.DATABASE_URL`
2. `/etc/hub/db.url` (single line, full URL)
3. Parse `/opt/hub-v04/.env.prod` for `POSTGRES_PASSWORD/USER/DB`, build `postgresql://...@127.0.0.1:5432/...`

If none works, `init()` throws and the module is skipped (Hub kernel boots with
partial degradation — other modules still work).

## Required infrastructure

- Docker socket at `/var/run/docker.sock` (host-side: PM2 user must be in `docker` group, or run as root)
- Postgres reachable on `127.0.0.1:5432` (when Hub runs on the host) or via `postgres` service name (when Hub is in Docker, step 8)
- `bots` table created (step 1, already done)
- `hub-bot-runner:latest` image built (step 3, already done)
