# Hub v0.2 Rebuild Plan

**Version:** 1.0 · **Date:** April 30, 2026
**Purpose:** Self-contained execution plan to rebuild Hub from scratch, reusing v0.1 code as raw material. Drop this into any Claude session along with the architecture doc and it should be enough to complete the rebuild end-to-end.

---

## Read First

Before doing anything, read the architecture document:
`docs/Hub-v0.1-architecture.md`

The principles defined there are inviolable. This document is implementation. If a step here contradicts the architecture, the architecture wins.

Hub v0.1 currently runs in production at hub.labs.co. It works, but its code structure does not reflect the architecture — everything lives inside one 2000-line `drafts.js` monolith named after a single module. v0.2 fixes this by rebuilding cleanly while reusing the working code.

---

## Server Access

SSH into hub.labs.co as root. Use Cockpit web terminal at port 9090 if available (preferred for Claude in Chrome sessions).

Server credentials are stored securely outside this document. Ask Eugene for current passwords before starting.

---

## Resources

### Repository
- **github.com/g0rd33v/hub** (public)
- Default branch: `main`
- Architecture doc: `docs/Hub-v0.1-architecture.md`

### Tools available to Claude
- **GitHub MCP** — read/write files via `github:create_or_update_file`, `github:get_file_contents`, `github:create_branch`
- **Claude in Chrome** — Cockpit terminal for server commands
- **bash_tool** — local checks only, cannot reach production server

---

## Strategy

You are NOT throwing away v0.1 code. You are reorganizing it. Map of source → destination:

| v0.1 source | v0.2 destination |
|---|---|
| `drafts/drafts.js` (monolith, ~2000 lines) | Split: `hub/server.js` + `modules/drafts/*` + `hub/credentials.js` |
| `drafts/runtime.js` | Split: `modules/runtime/sandbox.js` + `modules/buffer/index.js` |
| `drafts/project-routes.js` | `modules/runtime/routes.js` |
| `drafts/project-bots.js` | `modules/telegram/projects.js` |
| `drafts/telegram.js` | `modules/telegram/master.js` |
| `drafts/analytics.js` | `modules/analytics/index.js` |
| `drafts/rich-context.js` | `modules/runtime/context.js` |
| `web/` | `web/` unchanged |

**Dropped:**
- Old `telepath.js` code path (deprecated)
- Empty shell projects with no real content

**Preserved across reset:**
- Any project with real live content — restore from backup in Phase 2.

---

## Target Layout

### Repo structure

```
/opt/hub/
├── package.json
├── README.md
├── docs/
│   ├── Hub-v0.1-architecture.md
│   └── Hub-v0.2-rebuild-plan.md
├── hub/                          KERNEL — small, dumb about content
│   ├── server.js                 HTTP listener, single entry point
│   ├── config.js                 env + defaults
│   ├── credentials.js            SAP/PAP/AAP tokens
│   └── logger.js
├── modules/                      MODULES — independent units
│   ├── drafts/
│   │   ├── index.js
│   │   ├── projects.js
│   │   ├── git.js
│   │   ├── http.js
│   │   └── static.js
│   ├── runtime/
│   │   ├── index.js
│   │   ├── sandbox.js
│   │   ├── bots.js
│   │   ├── routes.js
│   │   └── context.js
│   ├── buffer/
│   │   └── index.js
│   ├── telegram/
│   │   ├── index.js
│   │   ├── master.js
│   │   └── projects.js
│   ├── analytics/
│   │   └── index.js
│   └── wizard/
│       ├── README.md
│       └── index.js              stub only
├── web/
│   ├── index.html
│   └── docs/index.html
└── deploy/
    ├── nginx/hub.labs.co.conf
    ├── pm2/ecosystem.config.cjs
    └── scripts/
        ├── install.sh
        ├── backup.sh
        └── restore.sh
```

### Server runtime layout

```
/var/lib/hub/projects/<name>/
  ├── live/
  ├── drafts/
  ├── versions/<N>/
  └── runtime/kv.sqlite

/var/lib/hub/state.json
/etc/hub/hub.env
/etc/hub/sap.token
/etc/hub/master-bot.token
/var/log/hub/
/var/backups/hub/
```

---

## Module Contract

Every module exports the same shape:

```javascript
export async function init(ctx) {
  // ctx = { config, paths, logger, credentials, modules }
}

// Optional: attach Express routes
export function mountRoutes(app, ctx) {}

// Optional: only drafts module uses this
export function mountProjectMiddleware(app, ctx) {}
```

Kernel loads each enabled module, calls `init(ctx)`, then `mountRoutes`. Drafts module's `mountProjectMiddleware` is called last. Modules talk to each other via `ctx.modules.<name>` — no cross-imports between module folders.

---

## Phase 0 — Pre-flight (15 min)

### 0.1 — Verify current v0.1 state

```bash
pm2 list --no-color | grep -E "name|drafts|hub"
ls /opt/hub/drafts/*.js
ls /var/lib/drafts/
curl -s http://localhost:3100/drafts/health | python3 -m json.tool | head -20
```

Expected: pm2 process running, source files present, health returns ok.

### 0.2 — Full backup

```bash
TS=$(date -u +%Y%m%d-%H%M%S)
mkdir -p /var/backups/hub-rebuild
tar -czf /var/backups/hub-rebuild/pre-v0.2-${TS}.tar.gz \
  /opt/hub /var/lib/drafts /etc/labs \
  /etc/nginx/sites-available/hub.labs.co \
  /root/.pm2/dump.pm2 2>/dev/null
ls -lh /var/backups/hub-rebuild/
```

Verify file exists and is at least a few MB.

### 0.3 — Save master bot token

```bash
cat /etc/labs/drafts.tbp
```

Save the token value somewhere safe before wiping. You'll need it in Phase 2.

### 0.4 — Verify GitHub access

Test read access to the repo. If write fails later, use Cockpit terminal with a PAT stored in `/root/.github_pat`.

---

## Phase 1 — Build v0.2 in repo (2-3 hours)

All work via GitHub MCP. Server stays untouched until Phase 2.

### 1.1 — Create branch

```
github:create_branch owner=g0rd33v repo=hub branch=v0.2-rebuild from_branch=main
```

All commits target `v0.2-rebuild`.

### 1.2 — Read all source files

Before writing anything, pull every source file you'll redistribute:
- `drafts/drafts.js`
- `drafts/runtime.js`
- `drafts/project-routes.js`
- `drafts/project-bots.js`
- `drafts/telegram.js`
- `drafts/analytics.js`
- `drafts/rich-context.js`
- `drafts/package.json`

Do not skip. You cannot redistribute what you haven't read.

### 1.3 — Write hub/config.js

Single source of configuration. All env vars, all defaults, all paths derived in one place.

```javascript
import 'dotenv/config';
const def = (k, fallback) => process.env[k] || fallback;

export const config = {
  serverNumber: parseInt(def('SERVER_NUMBER', '0'), 10),
  publicBase: def('PUBLIC_BASE', 'http://localhost:3100'),
  port: parseInt(def('HUB_PORT', '3100'), 10),
  dataDir: def('HUB_DATA_DIR', '/var/lib/hub'),
  configDir: def('HUB_CONFIG_DIR', '/etc/hub'),
  nodeEnv: def('NODE_ENV', 'development'),
  modules: {
    drafts: true,
    runtime: true,
    buffer: true,
    telegram: true,
    analytics: true,
    wizard: false,
  },
};

export const paths = {
  projects: () => `${config.dataDir}/projects`,
  project: (n) => `${config.dataDir}/projects/${n}`,
  projectLive: (n) => `${config.dataDir}/projects/${n}/live`,
  projectDrafts: (n) => `${config.dataDir}/projects/${n}/drafts`,
  projectVersions: (n) => `${config.dataDir}/projects/${n}/versions`,
  projectKv: (n) => `${config.dataDir}/projects/${n}/runtime/kv.sqlite`,
  state: () => `${config.dataDir}/state.json`,
  sapToken: () => `${config.configDir}/sap.token`,
  masterBotToken: () => `${config.configDir}/master-bot.token`,
};
```

### 1.4 — Write hub/logger.js

```javascript
const ts = () => new Date().toISOString();
const log = (level, ...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  const line = `${ts()} [${level}] ${msg}`;
  if (level === 'ERROR' || level === 'WARN') console.error(line);
  else console.log(line);
};
export const logger = {
  info: (...a) => log('INFO', ...a),
  warn: (...a) => log('WARN', ...a),
  error: (...a) => log('ERROR', ...a),
  child: (prefix) => ({
    info: (...a) => log('INFO', `[${prefix}]`, ...a),
    warn: (...a) => log('WARN', `[${prefix}]`, ...a),
    error: (...a) => log('ERROR', `[${prefix}]`, ...a),
  }),
};
```

### 1.5 — Write hub/credentials.js

Lift from `drafts.js`. Search for: `authPAPorSAP`, `authSAP`, `authAAP`, `signin`, `pass_`. Move all token logic here.

Keep existing token formats unchanged so legacy passes still work:
- SAP: 16 hex chars in `/etc/hub/sap.token`
- PAP: `pap_<hex>` minted per project
- AAP: `aap_<hex>` minted per agent

Export: `loadServerSAP()`, `generatePAP(projectName)`, `verifyToken(authHeader, level)`, `redeemPass(passString)`, `mountSigninRoutes(app, ctx)`.

### 1.6 — Write hub/server.js

```javascript
import express from 'express';
import { config, paths } from './config.js';
import { logger } from './logger.js';
import * as credentials from './credentials.js';

const modules = {};
const ctx = { config, paths, logger, credentials, modules };

// Load modules in dependency order
if (config.modules.buffer) {
  modules.buffer = await import('../modules/buffer/index.js');
  await modules.buffer.init(ctx);
}
if (config.modules.runtime) {
  modules.runtime = await import('../modules/runtime/index.js');
  await modules.runtime.init(ctx);
}
if (config.modules.drafts) {
  modules.drafts = await import('../modules/drafts/index.js');
  await modules.drafts.init(ctx);
}
if (config.modules.telegram) {
  modules.telegram = await import('../modules/telegram/index.js');
  await modules.telegram.init(ctx);
}
if (config.modules.analytics) {
  modules.analytics = await import('../modules/analytics/index.js');
  await modules.analytics.init(ctx);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({
  ok: true,
  version: '0.2.0',
  server_number: config.serverNumber,
  modules: Object.keys(modules),
  uptime_sec: Math.floor(process.uptime()),
}));

credentials.mountSigninRoutes(app, ctx);

for (const [name, mod] of Object.entries(modules)) {
  if (typeof mod.mountRoutes === 'function') {
    mod.mountRoutes(app, ctx);
    logger.info(`mounted routes: ${name}`);
  }
}

if (modules.drafts?.mountProjectMiddleware) {
  modules.drafts.mountProjectMiddleware(app, ctx);
}

app.listen(config.port, '127.0.0.1', () => {
  logger.info(`Hub v0.2 on 127.0.0.1:${config.port} — ${config.publicBase}`);
  logger.info(`Modules: ${Object.keys(modules).join(', ')}`);
});
```

### 1.7 — Write modules/buffer/index.js

Lift KV logic from `runtime.js`. Keep SQLite schema unchanged — existing kv.sqlite files must remain readable.

Export: `init(ctx)`, `getKv(projectName)` → `{ get, set, del, list, incr }`.

### 1.8 — Write modules/runtime/

Four files:

**sandbox.js** — vm Context, safe globals (Web Fetch APIs already whitelisted in v0.1: Request/Response/Headers/AbortController). 5s timeout.

**bots.js** — bot.js loader, cache by mtime, `dispatchBotUpdate(projectName, update)`. Uses `ctx.modules.buffer.getKv(projectName)`.

**routes.js** — routes.js loader, `tryDispatchHttp({projectName, expressReq, fullUrl, pathname, method})`. Returns `{matched, status, headers, body}` or `{matched: false}`. Same KV instance as bots.js — critical.

**context.js** — builds the `ctx` object for sandboxed code: `{ kv, log, project, now, req_ip, json, text, html, error, notFound, forbidden, badRequest }`.

**index.js** — `init(ctx)`, `mountRoutes` adds bot/routes status endpoints. Exports `dispatchBotUpdate`, `tryDispatchHttp`.

### 1.9 — Write modules/drafts/

**projects.js** — state.json management, `findProjectByName`, `createProject`, `listProjects`, `isProjectName`.

**git.js** — `commitDraft`, `promoteToLive`, `snapshotVersion`.

**http.js** — admin endpoints: `POST /drafts/projects`, `GET /drafts/projects`, `POST /drafts/upload`, `POST /drafts/commit`, `POST /drafts/promote`, `GET /drafts/health`, `GET /drafts/server/stats`.

**static.js** — `serveStatic`, `renderProjectLanding`.

**index.js** — `init`, `mountRoutes`, `mountProjectMiddleware`:

```javascript
app.use(async (req, res, next) => {
  // Accepts GET/HEAD/POST/PUT/DELETE/PATCH
  // Skip system paths: /drafts/ /signin/ /health etc.
  // Match /<projectname>/<rest>
  // 1. Version snapshots /v/<N>/... → read-only static
  // 2. routes.js dispatch via ctx.modules.runtime.tryDispatchHttp(...)
  // 3. Static serve from live/ + fallback landing
});
```

### 1.10 — Write modules/telegram/

**master.js** — @LabsHubBot polling, /start handler. Token from `paths.masterBotToken()`.

**projects.js** — per-project bot polling/webhook, dispatches to `ctx.modules.runtime.dispatchBotUpdate`.

**index.js** — `init`, `mountRoutes`.

### 1.11 — Write modules/analytics/index.js

Lift from existing `analytics.js`.

### 1.12 — Write modules/wizard/

**README.md** — placeholder for future Wizard module (see architecture doc roadmap).

**index.js** — stub: `export async function init(ctx) { ctx.logger.info('[wizard] placeholder'); }`

### 1.13 — Write deploy/pm2/ecosystem.config.cjs

```javascript
module.exports = {
  apps: [{
    name: 'hub',
    script: '/opt/hub/hub/server.js',
    cwd: '/opt/hub',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '512M',
    error_file: '/var/log/hub/error.log',
    out_file: '/var/log/hub/server.log',
    merge_logs: true,
    time: true,
  }],
};
```

### 1.14 — Write deploy/scripts/install.sh

```bash
#!/bin/bash
set -e
echo "=== Hub v0.2 install ==="

mkdir -p /var/lib/hub/projects /etc/hub /var/log/hub /var/backups/hub/{daily,manual}

if [ ! -f /etc/hub/sap.token ]; then
  openssl rand -hex 8 > /etc/hub/sap.token
  chmod 600 /etc/hub/sap.token
  echo "Generated SAP: $(cat /etc/hub/sap.token)"
fi

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

cd /opt/hub && npm install --production

ln -sf /opt/hub/deploy/nginx/hub.labs.co.conf /etc/nginx/sites-available/hub.labs.co
ln -sf /etc/nginx/sites-available/hub.labs.co /etc/nginx/sites-enabled/hub.labs.co
nginx -t && nginx -s reload

pm2 start /opt/hub/deploy/pm2/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "=== Install complete ==="
echo "SAP: $(cat /etc/hub/sap.token)"
echo "Test: curl http://localhost:3100/health"
```

### 1.15 — Write deploy/scripts/backup.sh

```bash
#!/bin/bash
TS=$(date -u +%Y%m%d-%H%M%S)
DEST=/var/backups/hub/daily
mkdir -p $DEST
tar -czf $DEST/hub-${TS}.tar.gz /var/lib/hub /etc/hub 2>/dev/null
ls -t $DEST/hub-*.tar.gz | tail -n +8 | xargs -r rm
echo "Backup: $DEST/hub-${TS}.tar.gz"
```

### 1.16 — Write root package.json

Single root package.json. Lift dependencies from existing `drafts/package.json`. Add: `"main": "hub/server.js"`, `"start": "node hub/server.js"`.

### 1.17 — Syntax check

```bash
find hub modules -name '*.js' -exec node --check {} \;
```

All must pass before proceeding.

### 1.18 — Merge to main

Tag current HEAD as `legacy-v0.1` for rollback. Merge `v0.2-rebuild` → `main`.

---

## Phase 2 — Server cutover (1-2 hours)

Server gets wiped and rebuilt clean.

### 2.1 — Backup live project data

```bash
TS=$(date -u +%Y%m%d-%H%M%S)
mkdir -p /var/backups/hub-rebuild
tar -czf /var/backups/hub-rebuild/projects-${TS}.tar.gz /var/lib/drafts
ls -lh /var/backups/hub-rebuild/
```

### 2.2 — Save credentials before wiping

```bash
# Current SAP
cat /etc/labs/drafts.sap

# Master bot token
cat /etc/labs/drafts.tbp

# Save both values — needed in Phase 2
```

### 2.3 — Stop old process

```bash
pm2 delete drafts || true
pm2 save --force
```

### 2.4 — Wipe old paths

```bash
rm -rf /opt/hub
rm -rf /var/lib/drafts
rm -rf /etc/labs
```

### 2.5 — Fresh clone

```bash
git clone https://github.com/g0rd33v/hub.git /opt/hub
cd /opt/hub && ls -la
# Should see: hub/ modules/ web/ deploy/ docs/ package.json
```

### 2.6 — Run install

```bash
chmod +x /opt/hub/deploy/scripts/install.sh
/opt/hub/deploy/scripts/install.sh
```

### 2.7 — Restore master bot token

```bash
echo 'SAVED_TOKEN_HERE' > /etc/hub/master-bot.token
chmod 600 /etc/hub/master-bot.token
pm2 restart hub
```

### 2.8 — Smoke test

```bash
curl -s http://localhost:3100/health | python3 -m json.tool
curl -sI https://hub.labs.co/
```

Expected: `ok=true`, `version=0.2.0`, all modules listed. Landing returns 200.

### 2.9 — Restore live projects

For each project with real content:

```bash
SAP=$(cat /etc/hub/sap.token)

# Create project
RESP=$(curl -s -X POST -H "Authorization: Bearer $SAP" \
  -H 'Content-Type: application/json' \
  http://localhost:3100/drafts/projects \
  -d '{"name":"<projectname>","description":"..."}')
echo $RESP

# Extract PAP from response, then upload each file:
PAP=<pap_from_response>
for F in /var/backups/hub-rebuild/extracted/live/*; do
  NAME=$(basename "$F")
  B64=$(base64 -w0 "$F")
  curl -s -X POST -H "Authorization: Bearer $PAP" \
    -H 'Content-Type: application/json' \
    http://localhost:3100/drafts/upload \
    -d "{\"filename\":\"$NAME\",\"content_b64\":\"$B64\"}"
  echo " uploaded: $NAME"
done

# Commit + promote
curl -s -X POST -H "Authorization: Bearer $PAP" \
  -H 'Content-Type: application/json' \
  http://localhost:3100/drafts/commit \
  -d '{"message":"restored from backup"}'

curl -s -X POST -H "Authorization: Bearer $PAP" \
  -H 'Content-Type: application/json' \
  http://localhost:3100/drafts/promote -d '{}'
```

To restore KV data, either re-bootstrap via API or copy kv.sqlite directly:
```bash
cp /path/to/backup/runtime/kv.sqlite \
   /var/lib/hub/projects/<name>/runtime/kv.sqlite
```

---

## Phase 3 — Verification (30 min)

### 3.1 — Functional checks

```bash
# Health
curl -s localhost:3100/health | python3 -m json.tool

# Project loads
curl -I https://hub.labs.co/<projectname>/

# Routes.js API
curl -s https://hub.labs.co/<projectname>/api/data

# Telegram bot
# Send /start to master bot in Telegram — should respond

# Project list
SAP=$(cat /etc/hub/sap.token)
curl -s -H "Authorization: Bearer $SAP" localhost:3100/drafts/projects
```

### 3.2 — Reboot test

```bash
reboot
# Wait 60s, SSH back in
pm2 list   # hub should be online
curl -s http://localhost:3100/health
```

### 3.3 — Update workflow test

Make a trivial commit to g0rd33v/hub, then on server:
```bash
cd /opt/hub && git pull && pm2 restart hub
curl -s http://localhost:3100/health
```

### 3.4 — Wire backup cron

```bash
cp /opt/hub/deploy/scripts/backup.sh /usr/local/bin/hub-backup.sh
chmod +x /usr/local/bin/hub-backup.sh
(crontab -l 2>/dev/null | grep -v backup; echo "0 3 * * * /usr/local/bin/hub-backup.sh") | crontab -
crontab -l
```

---

## Rollback

If Phase 2 fails:

```bash
pm2 delete hub

TS=<timestamp from 2.1>
tar -xzf /var/backups/hub-rebuild/projects-${TS}.tar.gz -C /

git clone https://github.com/g0rd33v/hub.git /opt/hub
cd /opt/hub && git checkout legacy-v0.1
npm install --production

pm2 start /opt/hub/drafts/drafts.js --name drafts
pm2 save
```

---

## Out of Scope for v0.2

Deferred to v0.3+. Do not attempt during this rebuild:

- Wizard module implementation
- Capability tokens beyond SAP/PAP/AAP
- Marketplace and credit settlement
- Buffer event sourcing
- Dynamic module discovery
- Multi-server coordination

---

## Decision Log

Append entries as decisions are made. Format: **Date · Decision · Rationale**

- 2026-04-30 · Modules loaded via hard-coded import list · Dynamic discovery is premature; flag-controlled is explicit and simple
- 2026-04-30 · Loose module contract (init/mountRoutes optional) · Solidifies in v0.3 when more modules exist
- 2026-04-30 · Buffer owns KV; runtime borrows via getKv() · Single owner of state
- 2026-04-30 · Token formats unchanged from v0.1 · Backwards compatibility with existing passes
- 2026-04-30 · Hard cut instead of parallel run · Nothing critical on server; clean cut is cheaper

---

*Hub v0.2 Rebuild Plan · v1.0 · April 30, 2026*
