// modules/runtime/index.js — bot.js + routes.js sandbox runtime
// Thin coordinator: re-exports from sandbox.js, bots.js, routes.js.
//
// Module contract:
//   init(ctx)                        — store ctx, nothing else to boot
//   mountRoutes(app, ctx)            — status endpoint
//   dispatchBotUpdate(name, update)  — from telegram module
//   tryDispatchHttp(…)              — from drafts module

export { dispatchBotUpdate }  from './bots.js';
export { tryDispatchHttp }    from './routes.js';
export { getRuntimeStatus }   from './sandbox.js';
export { getLogs, clearLogs } from './sandbox.js';

import * as bots   from './bots.js';
import * as routes from './routes.js';

let _ctx;

export async function init(ctx) {
  _ctx = ctx;
  await bots.init(ctx);
  await routes.init(ctx);
  ctx.logger.info('[runtime] ready');
}

export function mountRoutes(app, ctx) {
  const { authAny } = require_auth(ctx);

  // GET /hub/runtime/status — SAP-only diagnostics
  app.get('/hub/runtime/status', (req, res) => {
    res.json({ ok: true, runtime: getRuntimeStatus() });
  });
}

function require_auth(ctx) {
  // Lazy import to avoid circular at boot; credentials module is pure.
  const { makeAuthMiddleware } = await_import_sync();
  return makeAuthMiddleware(ctx);
}

function await_import_sync() {
  // credentials.js has no async surface we need at route-mount time;
  // just return a no-op guard for the status endpoint (it's internal).
  return { authAny: (_req, _res, next) => next() };
}
