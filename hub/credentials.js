// hub/credentials.js — SAP/PAP/AAP token management
import fs   from 'fs';
import crypto from 'crypto';

const TIER_BYTES = { sap: 8, pap: 6, aap: 5 };

export const newToken = (prefix) =>
  prefix + '_' + crypto.randomBytes(TIER_BYTES[prefix] || 6).toString('hex');

export const newId = () => crypto.randomBytes(4).toString('hex');

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

let _sap = null;

export function loadServerSAP(paths) {
  if (process.env.BEARER_TOKEN) { _sap = process.env.BEARER_TOKEN.trim(); return _sap; }
  if (process.env.SAP_TOKEN)    { _sap = process.env.SAP_TOKEN.trim();    return _sap; }
  const sapFile = paths.sapToken();
  if (fs.existsSync(sapFile)) {
    _sap = fs.readFileSync(sapFile, 'utf8').trim();
    return _sap;
  }
  _sap = crypto.randomBytes(8).toString('hex');
  try {
    fs.mkdirSync(require('path').dirname(sapFile), { recursive: true });
    fs.writeFileSync(sapFile, _sap + '\n', { mode: 0o600 });
  } catch (e) {
    console.log('SAP minted (NOT persisted): ' + _sap);
  }
  return _sap;
}

export function getSAP() { return _sap; }

export function parseBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function makeAuthMiddleware(ctx) {
  function findProjectByPAP(token) {
    return ctx.modules.drafts ? ctx.modules.drafts.findProjectByPAP(token) : null;
  }
  function findProjectAndAAPByAAPToken(token) {
    return ctx.modules.drafts ? ctx.modules.drafts.findProjectAndAAPByAAPToken(token) : null;
  }

  function rlGuard(tier, id, res, next) {
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
      return rlGuard('sap', 'root', res, () => { req.tier = 'sap'; next(); });
    },
    authPAPorSAP(req, res, next) {
      const tok = parseBearer(req);
      if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (tok === getSAP()) { req.tier = 'sap'; return next(); }
      const p = findProjectByPAP(tok);
      if (p) return rlGuard('pap', p.pap.id, res, () => { req.tier = 'pap'; req.project = p; next(); });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    },
    authAny(req, res, next) {
      const tok = parseBearer(req);
      if (!tok) return res.status(401).json({ ok: false, error: 'unauthorized' });
      if (tok === getSAP()) { req.tier = 'sap'; return next(); }
      const p = findProjectByPAP(tok);
      if (p) return rlGuard('pap', p.pap.id, res, () => { req.tier = 'pap'; req.project = p; next(); });
      const aapHit = findProjectAndAAPByAAPToken(tok);
      if (aapHit) return rlGuard('aap', aapHit.aap.id, res, () => { req.tier = 'aap'; req.project = aapHit.project; req.aap = aapHit.aap; next(); });
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    },
  };
}

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
      if      (role === 'server')  { tier = 'sap'; token = newFmt[3]; }  // FIX: extract token for server role
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

  app.get('/m/:token', (req, res) =>
    res.status(410).type('html').send('<h1>This link has expired</h1><p>Hub was upgraded. Ask the server owner for a fresh link.</p>')
  );
}
