// modules/drafts/index.js
import * as httpApi     from './http.js';
import * as staticServe from './static.js';
import { mountWebAppRoutes } from './webapp.js';

export async function init(ctx)               { return httpApi.init(ctx); }
export function mountRoutes(app, ctx)         { httpApi.mountRoutes(app, ctx); mountWebAppRoutes(app, ctx); }
export function mountProjectMiddleware(a, c)  { staticServe.mountProjectMiddleware(a, c); }
export function handleSignin(req, res, opts)  { return staticServe.renderSignin(req, res, opts); }
export function getState()                    { return httpApi.getState(); }
export function saveState()                   { return httpApi.saveState(); }
export function findProjectByPAP(token)        { return httpApi.findProjectByPAP(token); }
export function findProjectAndAAPByAAPToken(t) { return httpApi.findProjectAndAAPByAAPToken(t); }
