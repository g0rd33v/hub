// modules/telegram/index.js — master bot + per-project bots coordinator
//
// Module contract:
//   init(ctx)         — init master bot + project bots
//   mountRoutes(app)  — optional: Telegram webhook endpoints if ever needed

export { hooks } from './master.js';

import * as master   from './master.js';
import * as projects from './projects.js';

export async function init(ctx) {
  await master.init(ctx);
  await projects.init(ctx);
  ctx.logger.info('[telegram] ready');
}

export function mountRoutes(app, ctx) {
  master.mountRoutes(app, ctx);
}
