// modules/drafts/index.js — drafts module coordinator
// Owns: state.json, project lifecycle, git operations, static serving,
// admin HTTP API, signin page rendering.
//
// Module contract:
//   init(ctx)                    — load state, ensure dirs
//   mountRoutes(app, ctx)        — /drafts/* admin API
//   mountProjectMiddleware(app)  — catch-all /<project>/* serving
//   handleSignin(req, res, opts) — called by hub/credentials.js
//   getState()                   — live state reference
//   saveState()                  — persist state.json
//   findProjectByPAP(token)      — used by credentials
//   findProjectAndAAPByAAPToken  — used by credentials

export * from './projects.js';
export * from './http.js';
export { renderSignin as handleSignin } from './static.js';

import * as projects from './projects.js';
import * as httpApi  from './http.js';
import * as staticServe from './static.js';

let _ctx;

export async function init(ctx) {
  _ctx = ctx;
  await projects.init(ctx);
  await httpApi.init(ctx);
  await staticServe.init(ctx);
  ctx.logger.info('[drafts] ready,', projects.getState().projects.length, 'projects');
}

export function mountRoutes(app, ctx) {
  httpApi.mountRoutes(app, ctx);
}

export function mountProjectMiddleware(app, ctx) {
  staticServe.mountProjectMiddleware(app, ctx);
}

export function getState()  { return projects.getState(); }
export function saveState() { return projects.saveState(); }

export function findProjectByPAP(token) {
  return projects.getState().projects.find(p => p.pap?.token === token && !p.pap?.revoked) || null;
}

export function findProjectAndAAPByAAPToken(token) {
  for (const p of projects.getState().projects) {
    const a = (p.aaps || []).find(x => x.token === token && !x.revoked);
    if (a) return { project: p, aap: a };
  }
  return null;
}
