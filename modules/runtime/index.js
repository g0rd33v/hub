// modules/runtime/index.js
export { dispatchBotUpdate } from './bots.js';
export { tryDispatchHttp, hasRoutesJs, getRoutesStatus } from './routes.js';
export { getRuntimeStatus, getLogs, clearLogs } from './sandbox.js';

import * as bots from './bots.js';
import * as routes from './routes.js';

export async function init(ctx) {
  await bots.init(ctx);
  await routes.init(ctx);
  ctx.logger.info('[runtime] ready');
}

export function mountRoutes(app, ctx) {
  app.get('/hub/runtime/status', (req, res) => {
    res.json({ ok: true, runtime: [] });
  });
}
