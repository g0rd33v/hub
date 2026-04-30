// modules/runtime/sandbox.js — vm Context, module loading, log ring
// Consolidated from drafts/runtime.js (KV removed — now lives in buffer module).

import fs     from 'fs';
import path   from 'path';
import vm     from 'vm';
import crypto from 'crypto';

const RUNTIME_TIMEOUT_MS = 5000;
const LOG_RING_SIZE      = 1000;

let _ctx;

export function init(ctx) { _ctx = ctx; }

// ─── Logs ───────────────────────────────────────────────────────────────────
const logRegistry = new Map(); // projectName → logger

export function makeLogger() {
  const ring = [];
  function push(level, args) {
    const line = args
      .map(a => typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())
      .join(' ')
      .slice(0, 2000);
    ring.push({ at: new Date().toISOString(), level, line });
    if (ring.length > LOG_RING_SIZE) ring.splice(0, ring.length - LOG_RING_SIZE);
  }
  return {
    log:   (...a) => push('info',  a),
    info:  (...a) => push('info',  a),
    warn:  (...a) => push('warn',  a),
    error: (...a) => push('error', a),
    read:  (limit) => ring.slice(-(limit || 200)),
    clear: () => { ring.length = 0; },
  };
}

export function getOrMakeLogger(projectName) {
  if (!logRegistry.has(projectName)) logRegistry.set(projectName, makeLogger());
  return logRegistry.get(projectName);
}

export function getLogs(projectName, limit) {
  const l = logRegistry.get(projectName);
  if (!l) return { lines: [], present: false };
  return { lines: l.read(limit), present: true };
}

export function clearLogs(projectName) {
  logRegistry.get(projectName)?.clear();
}

// ─── Safe globals ──────────────────────────────────────────────────────────
export function safeGlobals(logger) {
  return {
    URL, URLSearchParams, TextEncoder, TextDecoder,
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    JSON, Math, Date, Object, Array, String, Number, Boolean,
    RegExp, Error, TypeError, Map, Set, WeakMap, WeakSet,
    Promise, Symbol, Buffer,
    console: {
      log:   (...a) => logger.log(...a),
      info:  (...a) => logger.info(...a),
      warn:  (...a) => logger.warn(...a),
      error: (...a) => logger.error(...a),
    },
    crypto: {
      randomUUID:    () => crypto.randomUUID(),
      getRandomValues: (arr) => crypto.getRandomValues(arr),
    },
    setTimeout, clearTimeout, queueMicrotask,
  };
}

// ─── Module loader ──────────────────────────────────────────────────────────
// Shared by bots.js and routes.js.
export async function loadUserModule(livePath, logger, expectedExportType) {
  if (!fs.existsSync(livePath)) return { module: null, mtime: null };
  const stat = fs.statSync(livePath);
  const src  = fs.readFileSync(livePath, 'utf8');

  if (/\brequire\s*\(/.test(src))
    throw new Error(`${path.basename(livePath)}: require() is not available; use ES module exports`);

  let transformed   = src;
  let defaultExport = null;
  const namedExports = [];

  // export default async function NAME (...)
  transformed = transformed.replace(
    /\bexport\s+default\s+(async\s+)?function\s*(\w*)\s*\(/g,
    (_, asyncKw = '', name) => {
      defaultExport = name || '__default__';
      return (asyncKw || '') + 'function ' + (name || '__default__') + '(';
    }
  );
  // export default <expr>
  transformed = transformed.replace(/\bexport\s+default\s+/g, 'const __default__ = ');
  if (!defaultExport) defaultExport = '__default__';

  // export async function NAME (...)
  transformed = transformed.replace(
    /\bexport\s+(async\s+)?function\s+(\w+)\s*\(/g,
    (_, asyncKw = '', name) => { namedExports.push(name); return (asyncKw || '') + 'function ' + name + '('; }
  );
  // export const NAME =
  transformed = transformed.replace(
    /\bexport\s+const\s+(\w+)/g,
    (_, name) => { namedExports.push(name); return 'const ' + name; }
  );
  // export { a, b }
  transformed = transformed.replace(
    /\bexport\s*\{([^}]+)\}/g,
    (_, list) => {
      for (const n of list.split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean))
        namedExports.push(n);
      return '';
    }
  );

  const exportsList = [
    'default: ' + defaultExport,
    ...namedExports.map(n => n + ': ' + n),
  ].join(', ');
  const wrapped = '(async () => {\n' + transformed + '\nreturn { ' + exportsList + ' };\n})()';

  const vmCtx  = vm.createContext(safeGlobals(logger), { name: 'hub:' + path.basename(livePath) });
  const script = new vm.Script(wrapped, { filename: path.basename(livePath), timeout: 1000 });
  const mod    = await Promise.race([
    script.runInContext(vmCtx, { timeout: 1000 }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('load timeout')), 3000)),
  ]);
  return { module: mod, mtime: stat.mtimeMs };
}

export function getRuntimeStatus() {
  const out = [];
  for (const [name, l] of logRegistry) {
    out.push({ project: name, log_lines: l.read(0).length });
  }
  return out;
}
