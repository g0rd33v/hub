// hub/server.js — Hub v0.5.1 kernel
// Single entry point. Loads modules in dependency order, mounts routes,
// starts Express listener.

import express from 'express';
import os      from 'os';
import { config, paths } from './config.js';
import { logger }        from './logger.js';
import { loadServerSAP, mountSigninRoutes } from './credentials.js';
import { STATUS_HTML, STATUS_SLUG }          from './status.js';

const VERSION = '0.5.1';

// Load SAP before anything else.
loadServerSAP(paths);

const modules = {};
const ctx = { config, paths, logger, modules };

async function loadModule(name, importPath) {
  if (!config.modules[name]) {
    logger.info(`module skipped (disabled): ${name}`);
    return;
  }
  try {
    const mod = await import(importPath);
    modules[name] = mod;
    await mod.init(ctx);
    logger.info(`module loaded: ${name}`);
  } catch (e) {
    logger.error(`module ${name} FAILED to load: ${e.message}`);
    if (e.stack) logger.error(e.stack);
  }
}

await loadModule('buffer',    '../modules/buffer/index.js');
await loadModule('runtime',   '../modules/runtime/index.js');
await loadModule('drafts',    '../modules/drafts/index.js');
await loadModule('telegram',  '../modules/telegram/index.js');
await loadModule('analytics', '../modules/analytics/index.js');
await loadModule('wizard',    '../modules/wizard/index.js');
await loadModule('botctl',    '../modules/botctl/index.js');
await loadModule('internal',  '../modules/internal/index.js');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  req.id = Math.random().toString(36).slice(2, 10);
  const t0 = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - t0;
    if (res.statusCode >= 400 || dur > 1000) {
      logger.info(`req=${req.id} ${req.method} ${req.path} ${res.statusCode} ${dur}ms`);
    }
  });
  next();
});

app.get('/health', (req, res) => res.json({
  ok:            true,
  version:       VERSION,
  server_number: config.serverNumber,
  modules:       Object.keys(modules),
  uptime_sec:    Math.floor(process.uptime()),
}));

import { readFileSync as _rfs } from 'fs';
import { fileURLToPath as _fup } from 'url';
import { dirname as _dn, join as _jn } from 'path';
const _dir = _dn(_fup(import.meta.url));
const _LANDING   = _rfs(_jn(_dir, '../web/index.html'), 'utf8');
const _DOCS      = _rfs(_jn(_dir, '../web/docs/index.html'), 'utf8');
const _TELEGRAM  = _rfs(_jn(_dir, '../web/telegram/index.html'), 'utf8');
app.get('/', (req, res) => res.type('html').send(_LANDING));
app.get('/docs', (req, res) => res.type('html').send(_DOCS));
app.get('/docs/', (req, res) => res.redirect(301, '/docs'));
app.get('/telegram', (req, res) => res.type('html').send(_TELEGRAM));
mountSigninRoutes(app, ctx);

app.get('/status/' + STATUS_SLUG, (req, res) =>
  res.type('html').send(STATUS_HTML));
app.get('/status/' + STATUS_SLUG + '/stage-health', async (req, res) => {
  try {
    const r = await fetch('http://localhost:3101/health', { signal: AbortSignal.timeout(3000) });
    res.json(await r.json());
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
app.get('/status/' + STATUS_SLUG + '/infra', async (req, res) => {
  const { execSync } = await import('child_process');
  const mb = v => Math.round(v / 1024 / 1024);
  const mem = process.memoryUsage();
  const loadAvg = os.loadavg()[0];
  let docker = { ok: false, label: 'unknown' };
  try {
    const out = execSync('docker ps --format {{.Names}} 2>/dev/null', { timeout: 2000 }).toString().trim();
    const containers = out ? out.split('\n').filter(Boolean) : [];
    docker = { ok: containers.length > 0, label: containers.length + ' containers' };
  } catch {}
  let pg = { ok: false, label: 'unreachable' };
  try {
    execSync('docker exec hub-postgres pg_isready -U hubuser -d hubdb -q 2>/dev/null', { timeout: 2000 });
    pg = { ok: true, label: 'healthy' };
  } catch {}
  res.json({
    'prod':       { ok: true,                label: 'online' },
    'stage':      { ok: true,                label: 'online' },
    'nginx':      { ok: true,                label: 'docker' },
    'postgres':   pg,
    'docker':     docker,
    'mem (rss)':  { ok: mb(mem.rss) < 500,   label: mb(mem.rss) + ' MB' },
    'load avg':   { ok: loadAvg < 2,         label: loadAvg.toFixed(2) },
  });
});

for (const [name, mod] of Object.entries(modules)) {
  if (typeof mod.mountRoutes === 'function') {
    try {
      mod.mountRoutes(app, ctx);
      logger.info(`mounted routes: ${name}`);
    } catch (e) {
      logger.error(`mount routes ${name} FAILED: ${e.message}`);
    }
  }
}

if (modules.drafts && typeof modules.drafts.mountProjectMiddleware === 'function') {
  modules.drafts.mountProjectMiddleware(app, ctx);
}

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.info(`Hub v${VERSION} on 0.0.0.0:${config.port}`);
  logger.info(`public_base: ${config.publicBase}`);
  logger.info(`server_number: ${config.serverNumber}`);
  logger.info(`modules: ${Object.keys(modules).join(', ')}`);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${sig}, shutting down...`);
  server.close(() => {
    logger.info('http server closed');
    setTimeout(() => process.exit(0), 500);
  });
  setTimeout(() => {
    logger.error('forced exit after 10s timeout');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => {
  logger.error('uncaughtException:', e.message);
  if (e.stack) logger.error(e.stack);
});
process.on('unhandledRejection', (e) => {
  logger.error('unhandledRejection:', e?.message || String(e));
});
