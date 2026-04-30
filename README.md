# Hub

Protocol-level routing conductor. Hub is infrastructure, not a product.

Running in production at [hub.labs.co](https://hub.labs.co).

## Architecture

See [docs/Hub-v0.1-architecture.md](docs/Hub-v0.1-architecture.md).

## v0.2 Layout

```
hub/          Kernel — server.js, config.js, credentials.js, logger.js
modules/      Modules — independent units
  buffer/     Per-project KV store (SQLite)
  runtime/    bot.js + routes.js sandbox (vm)
  drafts/     Static hosting, git versioning, admin API
  telegram/   Master bot + per-project bot polling
  analytics/  Update recording + daily snapshots
  wizard/     Stub (v0.3)
web/          Public web (index.html, docs/index.html)
deploy/       nginx config, pm2 ecosystem, install/backup scripts
docs/         Architecture and rebuild plan documents
```

## Quick start

```bash
git clone https://github.com/g0rd33v/hub.git /opt/hub
chmod +x /opt/hub/deploy/scripts/install.sh
/opt/hub/deploy/scripts/install.sh
curl http://localhost:3100/health
```

## Docs

- [hub.labs.co/docs](https://hub.labs.co/docs) — user-facing reference
- [docs/Hub-v0.1-architecture.md](docs/Hub-v0.1-architecture.md) — architecture principles
- [docs/Hub-v0.2-rebuild-plan.md](docs/Hub-v0.2-rebuild-plan.md) — rebuild execution plan

## License

MIT
