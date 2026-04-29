// project-routes.js — Hub HTTP API endpoints for projects (routes.js support)
//
// Activated when a project's live/ directory contains routes.js. drafts loads
// it via the same sandbox as bot.js, executes its default export (an object
// mapping "METHOD /path" → async handler) for every matching HTTP request
// to /<project>/<path>.
//
// Authoring contract (in user's routes.js):
//   export default {
//     "GET /api/visits":  async (req, ctx) => { ... },
//     "POST /api/visit":  async (req, ctx) => { ... },
//     "POST /api/data":   async (req, ctx) => { ... },
//     "GET /api/data":    async (req, ctx) => { ... }
//   }
//
// Handler arguments:
//   req — standard Web Fetch Request (req.method, req.url, await req.json(),
//         await req.text(), req.headers)
//   ctx — same shape as bot.js:
//           ctx.kv             per-project SQLite KV
//           ctx.log            logger (info/warn/error)
//           ctx.project        project name
//           ctx.now            ISO timestamp
//           ctx.req_ip         best-effort client IP (X-Forwarded-For first)
//         plus response helpers:
//           ctx.json(data, init?)        → Response.json()
//           ctx.text(str, init?)         → text/plain
//           ctx.html(str, init?)         → text/html
//           ctx.error(status, msg)       → status code with message
//           ctx.notFound(msg?)           → 404
//           ctx.forbidden(msg?)          → 403
//           ctx.badRequest(msg?)         → 400
//
// Handler return values (Hub coerces):
//   - Web Response object         → returned as-is
//   - plain object/array          → ctx.json(value)
//   - string                      → ctx.text(value)
//   - number                      → empty body with that status
//   - null/undefined              → 204 No Content
//
// Sandbox: same Node vm Context as bot.js (Web Fetch globals already
// whitelisted: Request, Response, Headers, AbortController, AbortSignal).
// Same 5s timeout per invocation. Same KV (10 MiB cap).
//
// Errors:
//   handler threw    → 500
//   timeout 5s       → 504
//   no routes.js     → returns null (caller falls through to static serve)
//   no match         → returns null (caller falls through to static serve)

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';

const ROUTES_TIMEOUT_MS = 5000;
const ROUTES_LOAD_TIMEOUT_MS = 3000;

const DRAFTS_DIR = process.env.DRAFTS_DIR || '/var/lib/drafts';

// projectName -> { module, mtime, importErr }
const registry = new Map();

// 
// Sandbox  same shape as runtime.js:safeGlobals(); kept here as a copy so
// project-routes.js does not import internals from runtime.js (clean module
// boundary). If runtime.js's globals change, mirror them here.
// 
function safeGlobals(logger) {
  return {
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Symbol,
    Buffer,
    console: {
      log:   (...a) => logger.log(...a),
      info:  (...a) => logger.info(...a),
      warn:  (...a) => logger.warn(...a),
      error: (...a) => logger.error(...a),
    },
    crypto: {
      randomUUID: () => crypto.randomUUID(),
      getRandomValues: (arr) => crypto.getRandomValues(arr),
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
}

async function loadRoutesModule(projectName, logger) {
  const livePath = path.join(DRAFTS_DIR, projectName, 'live', 'routes.js');
  if (!fs.existsSync(livePath)) return { module: null, mtime: null };
  const stat = fs.statSync(livePath);
  const src = fs.readFileSync(livePath, 'utf8');

  if (/\brequire\s*\(/.test(src)) {
    throw new Error('routes.js: require() is not available; use ES module exports');
  }

  // Same wrap-and-extract trick as runtime.js. routes.js needs only
  // `export default <object>` semantics, so we keep this minimal.
  let transformed = src;
  let defaultExport = null;

  // export default <expr>
  if (/\bexport\s+default\s+/.test(transformed)) {
    transformed = transformed.replace(/\bexport\s+default\s+/, 'const __default__ = ');
    defaultExport = '__default__';
  }
  if (!defaultExport) {
    throw new Error('routes.js: must have `export default { ... }`');
  }

  const wrapped =
    '(async () => {\n' +
    transformed + '\n' +
    'return { default: __default__ };\n' +
    '})()';

  const ctx = vm.createContext(safeGlobals(logger), { name: 'drafts-routes:' + projectName });
  const script = new vm.Script(wrapped, { filename: 'routes.js', timeout: 1000 });
  const promise = script.runInContext(ctx, { timeout: 1000 });
  const module = await Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('routes.js load timeout')),
      ROUTES_LOAD_TIMEOUT_MS,
    )),
  ]);

  return { module, mtime: stat.mtimeMs };
}

// 
// Public API
// 

export function hasRoutesJs(projectName) {
  const livePath = path.join(DRAFTS_DIR, projectName, 'live', 'routes.js');
  return fs.existsSync(livePath);
}

// Returns cached module or loads + caches.
async function ensureLoaded(projectName, logger) {
  if (!hasRoutesJs(projectName)) {
    if (registry.has(projectName)) registry.delete(projectName);
    return null;
  }
  const livePath = path.join(DRAFTS_DIR, projectName, 'live', 'routes.js');
  const stat = fs.statSync(livePath);
  const cached = registry.get(projectName);
  if (cached && cached.mtime === stat.mtimeMs && !cached.importErr) return cached;

  try {
    const { module } = await loadRoutesModule(projectName, logger);
    const entry = { module, mtime: stat.mtimeMs, importErr: null };
    registry.set(projectName, entry);
    logger.info('[routes] loaded routes.js (' + Object.keys(module.default || {}).length + ' routes)');
    return entry;
  } catch (e) {
    const entry = { module: null, mtime: stat.mtimeMs, importErr: e.message };
    registry.set(projectName, entry);
    logger.error('[routes] failed to load routes.js:', e.message);
    return entry;
  }
}

// Match incoming METHOD + PATH against routes table.
// Returns the handler function or null.
function matchRoute(routesObj, method, pathname) {
  if (!routesObj || typeof routesObj !== 'object') return null;
  const wantedKey = method.toUpperCase() + ' ' + pathname;
  if (typeof routesObj[wantedKey] === 'function') return routesObj[wantedKey];
  // Try case-insensitive method match (people sometimes write "get /x")
  for (const key of Object.keys(routesObj)) {
    const [m, p] = key.split(/\s+/, 2);
    if (m && p && m.toUpperCase() === method.toUpperCase() && p === pathname) {
      return routesObj[key];
    }
  }
  return null;
}

// 
// Build helpers (the ctx.json/text/error/etc shortcuts) — these are pure
// helpers operating on the global Response. No state.
// 
function makeHelpers() {
  return {
    json: (data, init = {}) => {
      const body = JSON.stringify(data);
      const headers = new Headers(init.headers || {});
      if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
      return new Response(body, { status: init.status || 200, headers });
    },
    text: (str, init = {}) => {
      const headers = new Headers(init.headers || {});
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
      return new Response(String(str), { status: init.status || 200, headers });
    },
    html: (str, init = {}) => {
      const headers = new Headers(init.headers || {});
      if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8');
      return new Response(String(str), { status: init.status || 200, headers });
    },
    error: (status, msg) => new Response(String(msg || ''), { status: Number(status) || 500 }),
    notFound: (msg) => new Response(String(msg || 'not found'), { status: 404 }),
    forbidden: (msg) => new Response(String(msg || 'forbidden'), { status: 403 }),
    badRequest: (msg) => new Response(String(msg || 'bad request'), { status: 400 }),
  };
}

// Coerce arbitrary handler return value into a Response.
function coerceResponse(value, helpers) {
  if (value instanceof Response) return value;
  if (value === null || value === undefined) return new Response('', { status: 204 });
  if (typeof value === 'string') return helpers.text(value);
  if (typeof value === 'number') return new Response('', { status: Number(value) || 200 });
  if (typeof value === 'object') return helpers.json(value);
  // Fallback: stringify
  return helpers.text(String(value));
}

// Convert an Express req into a Web Fetch Request. drafts uses Express, so we
// adapt: build a full URL using PUBLIC_BASE so URL parsing works inside the
// sandbox (req.url alone is path-only).
function expressToFetchRequest(req, fullUrl) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (Array.isArray(v)) headers.set(k, v.join(', '));
    else if (v !== undefined) headers.set(k, String(v));
  }
  const init = {
    method: req.method,
    headers,
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // req.body was already parsed by express.json() — convert back to a string
    // body so the handler can call await req.json() / await req.text() naturally.
    if (req.body !== undefined && req.body !== null) {
      const ct = headers.get('content-type') || '';
      if (typeof req.body === 'string') {
        init.body = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        init.body = req.body;
      } else {
        // Already-parsed JSON: re-stringify so handler can re-parse with req.json()
        init.body = JSON.stringify(req.body);
        if (!ct) headers.set('content-type', 'application/json');
      }
    }
  }
  return new Request(fullUrl, init);
}

// Entry point used by drafts.js.
//
// Returns one of:
//   { matched: false }                     — no routes.js or no route match; caller falls through to static
//   { matched: true,  status, headers, body }  — write to express res
//
// Caller is responsible for serving the response onto its Express res.
export async function tryDispatch({ project, projectName, kvForProject, logger, expressReq, fullUrl, pathname, method, getReqIp }) {
  const entry = await ensureLoaded(projectName, logger);
  if (!entry) return { matched: false };
  if (!entry.module || typeof entry.module.default !== 'object' || entry.module.default === null) {
    if (entry.importErr) {
      logger.error('[routes] cannot dispatch  routes.js failed to load: ' + entry.importErr);
      return {
        matched: true,
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'routes.js failed to load: ' + entry.importErr,
      };
    }
    return { matched: false };
  }
  const handler = matchRoute(entry.module.default, method, pathname);
  if (!handler) return { matched: false };

  const helpers = makeHelpers();
  const reqIp = getReqIp ? getReqIp() : null;
  const ctx = {
    kv: kvForProject,
    log: (...a) => logger.info(...a),
    project: projectName,
    now: new Date().toISOString(),
    req_ip: reqIp,
    json: helpers.json,
    text: helpers.text,
    html: helpers.html,
    error: helpers.error,
    notFound: helpers.notFound,
    forbidden: helpers.forbidden,
    badRequest: helpers.badRequest,
  };

  const fetchReq = expressToFetchRequest(expressReq, fullUrl);

  let response;
  try {
    const ret = await Promise.race([
      Promise.resolve(handler(fetchReq, ctx)),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error('routes handler timeout (' + ROUTES_TIMEOUT_MS + 'ms)')),
        ROUTES_TIMEOUT_MS,
      )),
    ]);
    response = coerceResponse(ret, helpers);
  } catch (e) {
    logger.error('[routes] handler threw on ' + method + ' ' + pathname + ': ' + e.message);
    const isTimeout = /timeout/i.test(e.message);
    response = new Response(
      isTimeout ? 'gateway timeout' : 'internal error',
      { status: isTimeout ? 504 : 500, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  // Convert Web Response into a shape Express can write.
  const headersOut = {};
  response.headers.forEach((v, k) => { headersOut[k] = v; });
  // Use arrayBuffer for binary safety
  const buf = Buffer.from(await response.arrayBuffer());
  return {
    matched: true,
    status: response.status,
    headers: headersOut,
    body: buf,
  };
}

// Diagnostics for /drafts/project/routes/logs and similar.
export function getRoutesStatus(projectName) {
  const entry = registry.get(projectName);
  if (!entry) return { present: false };
  return {
    present: true,
    has_module: !!entry.module,
    import_error: entry.importErr || null,
    routes: entry.module && entry.module.default
      ? Object.keys(entry.module.default).filter(k => typeof entry.module.default[k] === 'function')
      : [],
    mtime: entry.mtime ? new Date(entry.mtime).toISOString() : null,
  };
}

export function unloadProjectRoutes(projectName) {
  registry.delete(projectName);
}
