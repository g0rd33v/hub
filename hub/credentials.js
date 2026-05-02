// hub/credentials.js — SAP/PAP/AAP token management v0.5.0
//
// Tiers:
//   SAP  server root       — 16 byte hex (128 bits), stored in /etc/hub/sap.token
//   PAP  project owner     — "pap_" + 16 byte hex, minted per project
//   AAP  agent contributor — "aap_" + 16 byte hex, minted per agent
//
// v0.5 security changes:
//   - timingSafeEqual via safeEq() for SAP comparison
//   - All tier tokens bumped to 16 bytes (128 bits) — was 8/6/5
//   - SAP no longer printed to stdout / log files (TTY-only display)
//   - Periodic TTL cleanup of rate-limit Map (prevents memory leak)
//   - Proper ESM imports (removed CJS require() call)

import fs     from 'fs';
import path   from 'path';
import crypto from 'crypto';

// 16 bytes = 128 bits entropy for ALL tiers (was 8/6/5 — too weak)
const TIER_BYTES = { sap: 16, pap: 16, aap: 16 };

export const newToken = (prefix) =>
  prefix + '_' + crypto.randomBytes(TIER_BYTES[prefix] || 16).toString('hex');

export const newId = () => crypto.randomBytes(8).toString('hex');

// Rate limits
const RATE = {
  sap: { perMinute: 120, perHour: 2000,  perDay: 20000 },
  pap: { perMinute: 60,  perHour: 600,   perDay: 5000  },
  aap: { perMinute: 10,  perHour: 60,    perDay: 300   },
};
const hits = new Map();

// Periodic cleanup — prevents unbounded memory growth.
// Runs every 10 minutes, drops entries with no hits in last 24h.
// .unref() so it doesn't keep the process alive on shutdown.
setInterval(() => {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  for (const [key, arr] of hits.entries()) {
    const pruned = arr.filter(t => now - t < DAY_MS);
    if (pruned.length === 0) hits.delete(key);
    else if (pruned.length !== arr.length) hits.set(key, pruned);
  }
}, 10 * 60 * 1000).unref();

export function checkRate(tier, tokenId) {
  const limits = RATE[tier];
  if (!limits) return { ok: true };
  const nowMs = Date.now();
  const windows = [
    { bucket: 'm', ms: 60 * 1000,           max: limits.perMinute },
    { bucket: 'h', ms: 60 * 60 * 1000,      max: limits.perHour   },
    { bucket: 'd', ms: 24 * 60 * 60 * 1000, max: limits.perDay    },
  ];
  for (const w of windows) {
    const key  = tier + ':' + tokenId + ':' + w.bucket;
    const arr  = hits.get(key) || [];
    const pruned = arr.filter(t => nowMs - t < w.ms);
    if (pruned.length >= w.max) {
      const retryIn = Math.ceil((w.ms - (nowMs - pruned[0])) / 1000);
      return { ok: false, window: w.bucket, retryAfter: retryIn };
    }
    pruned.push(nowMs);
    hits.set(key, pruned);
  }
  return { ok: true };
}

// Timing-safe token comparison
export function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a, 'utf8');
  const B = Buffer.from(b, 'utf8');
  if (A.length !== B.length) {
    // Still do a comparison to avoid leaking length info via timing
    crypto.timingSafeEqual(A, A);
    return false;
  }
  return crypto.timingSafeEqual(A, B);
}

// SAP loader
let _sap = null;

export function loadServerSAP(paths) {
  if (process.env.BEARER_TOKEN) { _sap = process.env.BEARER_TOKEN.trim(); return _sap; }
  if (process.env.SAP_TOKEN)    { _sap = process.env.SAP_TOKEN.trim();    return _sap; }

  const sapFile = paths.sapToken();
  if (fs.existsSync(sapFile)) {
    _sap = fs.readFileSync(sapFile, 'utf8').trim();
    return _sap;
  }

  // Mint new SAP — 16 bytes (128 bits)
  // SECURITY: never write the SAP token to console/logs.
  // Show notice on TTY only when actually attached to a terminal.
  _sap = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(path.dirname(sapFile), { recursive: true });
    fs.writeFileSync(sapFile, _sap + '\n', { mode: 0o600 });
    if (process.stdout.isTTY) {
      const bar = '-'.repeat(56);
      process.stdout.write('\n' + bar + '\n');
      process.stdout.write('  hub: NEW SAP MINTED — saved to ' + sapFile + '\n');
      process.stdout.write('  Read it with:  sudo cat ' + sapFile + '\n');
      process.stdout.write(bar + '\n');
    }
  } catch (e) {
    // Even on persistence error, do NOT print the SAP value
    console.error('SAP minted but persistence failed:', e.message);
    console.error('SAP file path:', sapFile);
    console.error('Server will work in this session only — check directory permissions.');
  }
  return _sap;
}

export function getSAP() { return _sap; }

export function parseBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Middleware factories
export function makeAuthMiddleware(ctx) {
  function findProjectByPAP(token) {
    return ctx.modules.drafts ? ctx.modules.drafts.findProjectByPAP(token) : null;
  }
  function findProjectAndAAPByAAPToken(token) {
    return ctx.modules.drafts ? ctx.modules.drafts.findProjectAndAAPByAAPToken(token) : null;
  }
  function rateLimitDeny(rl, res) {
    res.set('Retry-After', rl.retryAfter);
    return res.status(429).json({
      ok: false, error: 'rate_limited',
      window: rl.window, retry_after: rl.retryAfter,
    });
  }

  return {
    authSAP(req, res, next) {
      const tok = parseBearer(req);
      if (!tok || !safeEq(tok, getSAP())) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      const rl = checkRate('sap', 'root');
      if (!rl.ok) return rateLimitDeny(rl, res);
      req.tier = 'sap';
      return next();
    },

    authPAPorSAP(req, res, next) {
      const tok = parseBearer(req);
      if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (safeEq(tok, getSAP())) { req.tier = 'sap'; return next(); }
      const p = findProjectByPAP(tok);
      if (p) {
        const rl = checkRate('pap', p.pap.id);
        if (!rl.ok) return rateLimitDeny(rl, res);
        req.tier = 'pap'; req.project = p;
        return next();
      }
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    },

    authAny(req, res, next) {
      const tok = parseBearer(req);
      if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (safeEq(tok, getSAP())) { req.tier = 'sap'; return next(); }
      const p = findProjectByPAP(tok);
      if (p) {
        const rl = checkRate('pap', p.pap.id);
        if (!rl.ok) return rateLimitDeny(rl, res);
        req.tier = 'pap'; req.project = p;
        return next();
      }
      const aapHit = findProjectAndAAPByAAPToken(tok);
      if (aapHit) {
        const rl = checkRate('aap', aapHit.aap.id);
        if (!rl.ok) return rateLimitDeny(rl, res);
        req.tier = 'aap'; req.project = aapHit.project; req.aap = aapHit.aap;
        return next();
      }
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    },
  };
}

// /signin route
export function mountSigninRoutes(app, ctx) {
  app.get('/signin/:token', async (req, res) => {
    let token = req.params.token || '';

    // Legacy portable format: drafts_<tier>_<N>_<hex>
    const portable = token.match(/^drafts_(server|project|agent)_(\d+)_([a-f0-9]+)$/i);
    if (portable) {
      const tierWord = portable[1].toLowerCase();
      const secret   = portable[3];
      if      (tierWord === 'server')  token = secret;
      else if (tierWord === 'project') token = 'pap_' + secret;
      else if (tierWord === 'agent')   token = 'aap_' + secret;
    }

    // New format: pass_<N>_<role>_<hex>
    const newFmt = token.match(/^pass_(\d+)_([a-z][a-z0-9]*)_(.+)$/);
    let tier;
    if (newFmt) {
      const role = newFmt[2];
      if      (role === 'server')  { tier = 'sap'; token = newFmt[3]; }
      else if (role === 'project') { tier = 'pap'; token = 'pap_' + newFmt[3]; }
      else if (role === 'agent')   { tier = 'aap'; token = 'aap_' + newFmt[3]; }
      else return res.status(404).send('not found');
    } else if (token.startsWith('pap_')) tier = 'pap';
    else if (token.startsWith('aap_'))  tier = 'aap';
    else if (/^[0-9a-f]{12,64}$/i.test(token)) tier = 'sap';
    else return res.status(404).send('not found');

    if (!ctx.modules.drafts) return res.status(503).send('drafts module not loaded');
    return ctx.modules.drafts.handleSignin(req, res, { tier, token });
  });

  // Legacy short links — expired notice
  app.get('/m/:token', (req, res) =>
    res.status(410).type('html').send(
      '<h1>This link has expired</h1><p>Hub was upgraded. Ask the server owner for a fresh link.</p>'
    )
  );
}
