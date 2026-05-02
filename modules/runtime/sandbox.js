// modules/runtime/sandbox.js — v0.5.0 hardened sandbox
//
// SECURITY CHANGES vs v0.3:
//   • Buffer REMOVED from safeGlobals (was a VM escape vector)
//   • fetch wrapped with SSRF protection (DNS resolution + private-IP block)
//   • Default 15s fetch timeout
//
// KNOWN LIMITATIONS (planned for v0.6 worker thread sandbox):
//   • vm.Script timeout only applies to SYNC code; async/await/Promise/setTimeout
//     bypass the timeout. User code can spin event loop without bound.
//   • No CPU/memory quota per project.

import fs     from 'fs';
import path   from 'path';
import vm     from 'vm';
import crypto from 'crypto';
import net    from 'net';

const RUNTIME_TIMEOUT_MS = 5000;
const LOG_RING_SIZE      = 1000;
const SAFE_FETCH_TIMEOUT = 15000;

let _ctx;

export function init(ctx) { _ctx = ctx; }

// ─── Logs ───────────────────────────────────────────────────────────────────────
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

// ─── SSRF protection ('private' = should not be reachable from user code) ──────────
export function isPrivateIP(ip) {
  if (!ip) return false;
  // IPv4 ranges
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 10) return true;                                 // 10.0.0.0/8
    if (o[0] === 127) return true;                                // 127.0.0.0/8 loopback
    if (o[0] === 169 && o[1] === 254) return true;                // link-local + cloud metadata (169.254.169.254)
    if (o[0] === 172 && o[1] >= 16  && o[1] <= 31) return true;   // 172.16.0.0/12
    if (o[0] === 192 && o[1] === 168) return true;                // 192.168.0.0/16
    if (o[0] === 0)   return true;                                // 0.0.0.0/8
    return false;
  }
  // IPv6 ranges
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;           // loopback / unspecified
    if (lower.startsWith('fe80:')) return true;                   // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;  // unique local (ULA)
    // IPv4-mapped IPv6 — unwrap and check the v4 portion
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped && net.isIPv4(mapped[1])) return isPrivateIP(mapped[1]);
  }
  return false;
}

export function makeSafeFetch(logger) {
  return async function safeFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new Error('safe-fetch: invalid URL'); }

    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error('safe-fetch: only http(s) protocol is allowed');
    }

    // Hostname literal-IP check (skip DNS if it's already an IP)
    const host = parsed.hostname;
    if (net.isIP(host)) {
      if (isPrivateIP(host)) throw new Error('safe-fetch: private IP blocked');
    } else {
      // Resolve and verify each address
      try {
        const dns = await import('dns/promises');
        const records = await dns.lookup(host, { all: true });
        for (const r of records) {
          if (isPrivateIP(r.address)) {
            logger.warn(`safe-fetch: blocked ${host} (resolves to private ${r.address})`);
            throw new Error('safe-fetch: host resolves to private IP');
          }
        }
      } catch (e) {
        if (e.message?.startsWith('safe-fetch:')) throw e;
        throw new Error('safe-fetch: DNS resolution failed: ' + e.message);
      }
    }

    // Apply default timeout if caller didn't set one
    const finalInit = { ...init };
    if (!finalInit.signal) {
      finalInit.signal = AbortSignal.timeout(SAFE_FETCH_TIMEOUT);
    }
    return globalThis.fetch(input, finalInit);
  };
}

// ─── Safe globals (HARDENED in v0.5) ─────────────────────────────────────────
export function safeGlobals(logger) {
  return {
    URL, URLSearchParams, TextEncoder, TextDecoder,
    fetch: makeSafeFetch(logger),
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    JSON, Math, Date, Object, Array, String, Number, Boolean,
    RegExp, Error, TypeError, Map, Set, WeakMap, WeakSet,
    Promise, Symbol,
    // SECURITY: Buffer is intentionally NOT exposed.
    // Buffer.from('').constructor.constructor('return process')() returns the
    // parent realm process object → escape from VM context. (V8/Node behavior.)
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

// ─── Module loader ──────────────────────────────────────────────────────────────
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
