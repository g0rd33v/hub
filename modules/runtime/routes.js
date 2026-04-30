// modules/runtime/routes.js — routes.js loader + HTTP dispatcher
// Lifted from drafts/project-routes.js.
// KV comes from ctx.modules.buffer.

import fs   from 'fs';
import path from 'path';
import { loadUserModule, getOrMakeLogger } from './sandbox.js';

const ROUTES_TIMEOUT_MS = 5000;

// projectName → { module, mtime, importErr }
const registry = new Map();

let _ctx;
export async function init(ctx) { _ctx = ctx; }

function livePath(projectName) {
  return path.join(_ctx.config.dataDir, 'projects', projectName, 'live', 'routes.js');
}

export function hasRoutesJs(projectName) {
  return fs.existsSync(livePath(projectName));
}

async function ensureLoaded(projectName) {
  if (!hasRoutesJs(projectName)) { registry.delete(projectName); return null; }
  const lp     = livePath(projectName);
  const stat   = fs.statSync(lp);
  const cached = registry.get(projectName);
  if (cached && cached.mtime === stat.mtimeMs && !cached.importErr) return cached;
  const logger = getOrMakeLogger(projectName);
  try {
    const { module } = await loadUserModule(lp, logger, 'object');
    const entry = { module, mtime: stat.mtimeMs, importErr: null };
    registry.set(projectName, entry);
    logger.info('[routes] loaded routes.js (' + Object.keys(module?.default || {}).length + ' routes)');
    return entry;
  } catch (e) {
    const entry = { module: null, mtime: stat.mtimeMs, importErr: e.message };
    registry.set(projectName, entry);
    logger.error('[routes] failed to load routes.js:', e.message);
    return entry;
  }
}

function matchRoute(routesObj, method, pathname) {
  if (!routesObj || typeof routesObj !== 'object') return null;
  const key = method.toUpperCase() + ' ' + pathname;
  if (typeof routesObj[key] === 'function') return routesObj[key];
  for (const k of Object.keys(routesObj)) {
    const [m, p] = k.split(/\s+/, 2);
    if (m?.toUpperCase() === method.toUpperCase() && p === pathname)
      return routesObj[k];
  }
  return null;
}

function makeHelpers() {
  return {
    json: (data, init = {}) => {
      const h = new Headers(init.headers || {});
      if (!h.has('content-type')) h.set('content-type', 'application/json; charset=utf-8');
      return new Response(JSON.stringify(data), { status: init.status || 200, headers: h });
    },
    text: (str, init = {}) => {
      const h = new Headers(init.headers || {});
      if (!h.has('content-type')) h.set('content-type', 'text/plain; charset=utf-8');
      return new Response(String(str), { status: init.status || 200, headers: h });
    },
    html: (str, init = {}) => {
      const h = new Headers(init.headers || {});
      if (!h.has('content-type')) h.set('content-type', 'text/html; charset=utf-8');
      return new Response(String(str), { status: init.status || 200, headers: h });
    },
    error:      (status, msg) => new Response(String(msg || ''), { status: Number(status) || 500 }),
    notFound:   (msg) => new Response(String(msg || 'not found'), { status: 404 }),
    forbidden:  (msg) => new Response(String(msg || 'forbidden'), { status: 403 }),
    badRequest: (msg) => new Response(String(msg || 'bad request'), { status: 400 }),
  };
}

function coerceResponse(value, helpers) {
  if (value instanceof Response) return value;
  if (value === null || value === undefined) return new Response('', { status: 204 });
  if (typeof value === 'string') return helpers.text(value);
  if (typeof value === 'number') return new Response('', { status: Number(value) || 200 });
  if (typeof value === 'object') return helpers.json(value);
  return helpers.text(String(value));
}

function expressToFetchRequest(req, fullUrl) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers || {})) {
    headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body != null) {
    init.body = typeof req.body === 'string' ? req.body
      : Buffer.isBuffer(req.body) ? req.body
      : JSON.stringify(req.body);
    if (!headers.has('content-type') && typeof req.body === 'object')
      headers.set('content-type', 'application/json');
  }
  return new Request(fullUrl, init);
}

export async function tryDispatchHttp({ projectName, expressReq, fullUrl, pathname, method }) {
  const entry = await ensureLoaded(projectName);
  if (!entry) return { matched: false };
  if (!entry.module || typeof entry.module.default !== 'object' || !entry.module.default) {
    if (entry.importErr) return { matched: true, status: 500, headers: { 'content-type': 'text/plain' }, body: 'routes.js failed: ' + entry.importErr };
    return { matched: false };
  }
  const handler = matchRoute(entry.module.default, method, pathname);
  if (!handler) return { matched: false };

  const logger  = getOrMakeLogger(projectName);
  const kv      = _ctx.modules.buffer.getKv(projectName);
  const helpers  = makeHelpers();
  const xff      = expressReq.headers['x-forwarded-for'];
  const req_ip   = (typeof xff === 'string' ? xff.split(',')[0].trim() : null) || expressReq.ip || null;
  const ctx = {
    kv, log: (...a) => logger.info(...a),
    project: projectName, now: new Date().toISOString(), req_ip,
    json: helpers.json, text: helpers.text, html: helpers.html,
    error: helpers.error, notFound: helpers.notFound,
    forbidden: helpers.forbidden, badRequest: helpers.badRequest,
  };

  let response;
  try {
    const ret = await Promise.race([
      Promise.resolve(handler(expressToFetchRequest(expressReq, fullUrl), ctx)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout (' + ROUTES_TIMEOUT_MS + 'ms)')), ROUTES_TIMEOUT_MS)),
    ]);
    response = coerceResponse(ret, helpers);
  } catch (e) {
    logger.error('[routes] handler threw on', method, pathname + ':', e.message);
    const isTimeout = /timeout/i.test(e.message);
    response = new Response(isTimeout ? 'gateway timeout' : 'internal error',
      { status: isTimeout ? 504 : 500, headers: { 'content-type': 'text/plain' } });
  }

  const headersOut = {};
  response.headers.forEach((v, k) => { headersOut[k] = v; });
  return { matched: true, status: response.status, headers: headersOut, body: Buffer.from(await response.arrayBuffer()) };
}

export function getRoutesStatus(projectName) {
  const entry = registry.get(projectName);
  if (!entry) return { present: false };
  return {
    present: true, has_module: !!entry.module, import_error: entry.importErr || null,
    routes: entry.module?.default ? Object.keys(entry.module.default).filter(k => typeof entry.module.default[k] === 'function') : [],
    mtime: entry.mtime ? new Date(entry.mtime).toISOString() : null,
  };
}
