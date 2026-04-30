// hub/server.js — Hub v0.2 kernel
// Single entry point. Loads modules in dependency order, mounts routes,
// starts Express listener.
//
// Architecture principle: this file stays small and dumb about content.
// Everything interesting lives in modules/.

import express from 'express';
import { config, paths } from './config.js';
import { logger }        from './logger.js';
import { loadServerSAP, mountSigninRoutes } from './credentials.js';

// Load SAP before anything else.
loadServerSAP(paths);

const modules = {};
const ctx = { config, paths, logger, modules };

// ─── Module boot ─────────────────────────────────────────────────────────────
// Load order matters: buffer first (state), then runtime (sandbox),
// then drafts (uses both), then telegram (uses drafts state),
// then analytics (uses drafts state).

if (config.modules.buffer) {
  const mod = await import('../modules/buffer/index.js');
  modules.buffer = mod;
  await mod.init(ctx);
  logger.info('module loaded: buffer');
}

if (config.modules.runtime) {
  const mod = await import('../modules/runtime/index.js');
  modules.runtime = mod;
  await mod.init(ctx);
  logger.info('module loaded: runtime');
}

if (config.modules.drafts) {
  const mod = await import('../modules/drafts/index.js');
  modules.drafts = mod;
  await mod.init(ctx);
  logger.info('module loaded: drafts');
}

if (config.modules.telegram) {
  const mod = await import('../modules/telegram/index.js');
  modules.telegram = mod;
  await mod.init(ctx);
  logger.info('module loaded: telegram');
}

if (config.modules.analytics) {
  const mod = await import('../modules/analytics/index.js');
  modules.analytics = mod;
  await mod.init(ctx);
  logger.info('module loaded: analytics');
}

if (config.modules.wizard) {
  const mod = await import('../modules/wizard/index.js');
  modules.wizard = mod;
  await mod.init(ctx);
  logger.info('module loaded: wizard');
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

// Health — kernel-level, always responds regardless of module state.
app.get('/health', (req, res) => res.json({
  ok:            true,
  version:       '0.2.0',
  server_number: config.serverNumber,
  modules:       Object.keys(modules),
  uptime_sec:    Math.floor(process.uptime()),
}));

// Signin — kernel owns the URL, delegates rendering to drafts module.
mountSigninRoutes(app, ctx);

// Module routes.
for (const [name, mod] of Object.entries(modules)) {
  if (typeof mod.mountRoutes === 'function') {
    mod.mountRoutes(app, ctx);
    logger.info(`mounted routes: ${name}`);
  }
}

// Drafts project middleware — must come last (catch-all for /<project>/*).
if (modules.drafts && typeof modules.drafts.mountProjectMiddleware === 'function') {
  modules.drafts.mountProjectMiddleware(app, ctx);
}

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(config.port, '127.0.0.1', () => {
  logger.info(`Hub v0.2.0 on 127.0.0.1:${config.port}`);
  logger.info(`public_base: ${config.publicBase}`);
  logger.info(`server_number: ${config.serverNumber}`);
  logger.info(`modules: ${Object.keys(modules).join(', ')}`);
});
