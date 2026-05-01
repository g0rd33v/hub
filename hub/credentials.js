// hub/credentials.js — SAP/PAP/AAP token management
// Lifted and reorganised from drafts/drafts.js.
// Token formats are unchanged for backwards compatibility with existing passes.
//
// Tiers:
//   SAP  server root       — 16 hex chars, stored in /etc/hub/sap.token
//   PAP  project owner     — "pap_" + 12 hex chars, minted per project
//   AAP  agent contributor — "aap_" + 10 hex chars, minted per agent
//
// URL scheme:
//   /signin/pass_<serverNum>_server_<sapHex>     → SAP welcome
//   /signin/pass_<serverNum>_project_<papHex>    → PAP welcome
//   /signin/pass_<serverNum>_agent_<aapHex>      → AAP welcome

import fs   from 'fs';
import crypto from 'crypto';

const TIER_BYTES = { sap: 8, pap: 6, aap: 5 };

export const newToken = (prefix) =>
  prefix + '_' + crypto.randomBytes(TIER_BYTES[prefix] || 6).toString('hex');

export const newId = () => crypto.randomBytes(4).toString('hex');

// ─── Rate limits ────────────────────────────────────────────────────────────
const RATE = {
  sap: { perMinute: 120, perHour: 2000,  perDay: 20000 },
  pap: { perMinute: 60,  perHour: 600,   perDay: 5000  },
  aap: { perMinute: 10,  perHour: 60,    perDay: 300   },
};
const hits = new Map();

export function checkRate(tier, tokenId) {
  const limits = RATE[tier];
  if (!limits) return { ok: true };
  const nowMs = Date.now();
  const windows = [
    { bucket: 'm', ms: 60 * 1000,       max: limits.perMinute },
    { bucket: 'h', ms: 60 * 60 * 1000,  max: limits.perHour   },
    { bucket: 'd', ms: 24 * 60 * 60 * 1000, max: limits.perDay },
  ];
  for (const w of windows) {
    const key  = `${tier}:${tokenId}:${w.bucket}`;
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

// ─── SAP loader ─────────────────────────────────────────────────────────────
let _sap = null;

export function loadServerSAP(paths) {
  // 1. env vars (legacy names kept for backwards compat)
  if (process.env.BEARER_TOKEN) { _sap = process.env.BEARER_TOKEN.trim(); return _sap; }
  if (process.env.SAP_TOKEN)    { _sap = process.env.SAP_TOKEN.trim();    return _sap; }

  // 2. /etc/hub/sap.token
  const sapFile = paths.sapToken();
  if (fs.existsSync(sapFile)) {
    _sap = fs.readFileSync(sapFile, 'utf8').trim();
    return _sap;
  }

  // 3. Mint new SAP
  _sap = crypto.randomBytes(8).toString('hex');
  try {
    fs.mkdirSync(require('path').dirname(sapFile), { recursive: true });
    fs.writeFileSync(sapFile, _sap + '\n', { mode: 0o600 });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  hub: NEW SAP MINTED — SAVE THIS, ONLY SHOWN ONCE');
    console.log('  SAP token: ' + _sap);
    console.log('  Saved to: ' + sapFile + ' (mode 0600)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (e) {
    console.log('SAP minted (NOT persisted, save now): ' + _sap + ' — error: ' + e.message);
  }
  return _sap;
}

export function getSAP() { return _sap; }

// ─── Token helpers ──────────────────────────────────────────────────────────
export function parseBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ─── Middleware factories ────────────────────────────────────────────────────
// These need access to state (projects) — state is passed in via ctx at
// mountSigninRoutes time, not imported (avoids circular dep).

export function makeAuthMiddleware(ctx) {
  const { modules } = ctx;

  function findProjectByPAP(token) {
    return ctx.modules.drafts
      ? ctx.modules.drafts.findProjectByPAP(token)
      : null;
  }
  function findProjectAndAAPByAAPToken(token) {
    return ctx.modules.drafts
      ? ctx.modules.drafts.findProjectAndAAPByAAPToken(token)
      : null;
  }

  function rateLimitGuard(tier, id, res, next) {
    const rl = checkRate(tier, id);
    if (!rl.ok) {
      res.set('Retry-After', rl.retryAfter);
      return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter });
    }
    return next();
  }

  return {
    authSAP(req, res, next) {
      const tok = parseBearer(req);
      if (!tok || tok !== getSAP()) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const rl = checkRate('sap', 'root');
      if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
      req.tier = 'sap';
      return next();
    },

    authPAPorSAP(req, res, next) {
      const tok = parseBearer(req);
      if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (tok === getSAP()) { req.tier = 'sap'; return next(); }
      const p = findProjectByPAP(tok);
      if (p) {
        const rl = checkRate('pap', p.pap.id);
        if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
        req.tier = 'pap'; req.project = p; return next();
      }
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    },

    authAny(req, res, next) {
      const tok = parseBearer(req);
      if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (tok === getSAP()) { req.tier = 'sap'; return next(); }
      const p = findProjectByPAP(tok);
      if (p) {
        const rl = checkRate('pap', p.pap.id);
        if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
        req.tier = 'pap'; req.project = p; return next();
      }
      const aapHit = findProjectAndAAPByAAPToken(tok);
      if (aapHit) {
        const rl = checkRate('aap', aapHit.aap.id);
        if (!rl.ok) { res.set('Retry-After', rl.retryAfter); return res.status(429).json({ ok: false, error: 'rate_limited', window: rl.window, retry_after: rl.retryAfter }); }
        req.tier = 'aap'; req.project = aapHit.project; req.aap = aapHit.aap; return next();
      }
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    },
  };
}

// ─── /signin route ──────────────────────────────────────────────────────────
// Mounted by server.js before modules so it works regardless of module state.

export function mountSigninRoutes(app, ctx) {
  app.get('/signin/:token', async (req, res) => {
    let token = req.params.token || '';

    // Legacy portable format: drafts_<tier>_<N>_<hex>
    const portable = token.match(/^drafts_(server|project|agent)_(\d+)_([a-f0-9]+)$/i);
    if (portable) {
      const tierWord = portable[1].toLowerCase();
      const secret   = portable[3];
      if (tierWord === 'server')  token = secret;
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

    // Delegate rendering to drafts module (it owns state + renderPage)
    if (!ctx.modules.drafts) return res.status(503).send('drafts module not loaded');
    return ctx.modules.drafts.handleSignin(req, res, { tier, token });
  });

  // Legacy short links — expired notice
  app.get('/m/:token', (req, res) =>
    res.status(410).type('html').send('<h1>This link has expired</h1><p>Hub was upgraded. Ask the server owner for a fresh link.</p>')
  );
}
