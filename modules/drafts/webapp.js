// modules/drafts/webapp.js — Hub v0.3
// Telegram Mini App dashboard: state API, bot management, analytics, broadcast
// Routes mounted via mountWebAppRoutes(app, ctx)

import fs   from 'fs';
import path from 'path';

let _ctx;

// ── Helpers ───────────────────────────────────────────────────────────────────

const readSAP = () => {
  try { return fs.readFileSync('/etc/hub/sap.token', 'utf8').trim(); } catch { return ''; }
};

const esc = s => s == null ? ''
  : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
             .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

const authPAP = (req, ctx) => {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
           || req.query?.token || '';
  // Normalise pass_ format
  const m = raw.match(/^pass_\d+_project_(.+)$/);
  const tok = m ? 'pap_' + m[1] : raw.startsWith('pap_') ? raw : null;
  if (!tok) return null;
  return ctx.modules.drafts?.findProjectByPAP(tok) || null;
};

const parseToken = (req) => {
  const fromQuery  = req.query?.token  || '';
  const fromHeader = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const raw = fromQuery || fromHeader;
  const sap = readSAP();

  const m = raw.match(/^pass_(\d+)_([a-z][a-z0-9]*)_(.+)$/);
  if (m) {
    if (m[2] === 'server')  return { tier: 'sap', token: m[3] };
    if (m[2] === 'project') return { tier: 'pap', token: 'pap_' + m[3] };
    if (m[2] === 'agent')   return { tier: 'aap', token: 'aap_' + m[3] };
  }
  if (raw.startsWith('pap_')) return { tier: 'pap', token: raw };
  if (raw.startsWith('aap_')) return { tier: 'aap', token: raw };
  if (/^[0-9a-f]{12,64}$/i.test(raw) && raw === sap) return { tier: 'sap', token: raw };
  return null;
};

// ── State builders ────────────────────────────────────────────────────────────

const buildSAPState = () => {
  const st   = _ctx.modules.drafts.getState();
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;

  return {
    tier:    'sap',
    server:  { base, server_number: sn, uptime_sec: Math.floor(process.uptime()) },
    projects: st.projects.map(p => ({
      name:             p.name,
      description:      p.description || p.name,
      live_url:         `${base}/${p.name}/`,
      pap_token:        p.pap?.token || null,
      pap_url:          p.pap?.token
                          ? `${base}/signin/pass_${sn}_project_${p.pap.token.replace(/^pap_/,'')}`
                          : null,
      has_bot:          !!(p.bot?.token),
      bot_username:     p.bot?.bot_username || null,
      bot_mode:         p.bot?.webhook_url ? 'webhook' : 'polling',
      subscriber_count: (p.bot?.subscribers || []).length,
      aap_count:        (p.aaps || []).filter(a => !a.revoked).length,
    })),
  };
};

const buildPAPState = (project) => {
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  const papHex = project.pap?.token?.replace(/^pap_/, '');
  const subs   = project.bot?.subscribers || [];

  // Language aggregation from in-memory subscribers
  const langs = Object.entries(
    subs.reduce((acc, s) => {
      const l = s.language_code || 'unknown';
      acc[l] = (acc[l] || 0) + 1;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return {
    tier:        'pap',
    name:        project.name,
    description: project.description || project.name,
    live_url:    `${base}/${project.name}/`,
    pap_token:   project.pap?.token || null,
    pap_url:     papHex ? `${base}/signin/pass_${sn}_project_${papHex}` : null,

    bot: project.bot ? {
      username:          project.bot.bot_username,
      mode:              project.bot.webhook_url ? 'webhook' : 'polling',
      webhook_url:       project.bot.webhook_url || null,
      webhook_log:       (project.bot.webhook_log || []).slice(0, 10),
      subscribers:       subs.length,
      analytics_enabled: project.bot.analytics_enabled ?? true,
      langs,
    } : null,

    github: {
      repo:     project.github_repo    || null,
      autosync: project.github_autosync || false,
    },

    aaps: (project.aaps || []).filter(a => !a.revoked).map(a => ({
      id:   a.id,
      name: a.name || a.id,
      url:  `${base}/signin/pass_${sn}_agent_${a.token.replace(/^aap_/, '')}`,
    })),

    api_base: `${base}/drafts`,
  };
};

const buildAAPState = (project, aap) => {
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  return {
    tier:      'aap',
    name:      project.name,
    aap_name:  aap.name || aap.id,
    branch:    aap.branch,
    live_url:  `${base}/${project.name}/`,
    aap_url:   `${base}/signin/pass_${sn}_agent_${aap.token.replace(/^aap_/, '')}`,
    api_base:  `${base}/drafts`,
    aap_token: aap.token,
  };
};

// ── Analytics helper ──────────────────────────────────────────────────────────

const readAnalyticsSummary = (projectName) => {
  const dataDir = _ctx.config.dataDir || '/var/lib/hub';
  const fp = path.join(dataDir, 'projects', projectName, 'analytics-summary.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
};

const buildAnalytics = (project) => {
  const subs    = project.bot?.subscribers || [];
  const byLang  = {};
  const byCoun  = {};

  subs.forEach(s => {
    const l = s.language_code || 'unknown';
    byLang[l] = (byLang[l] || 0) + 1;
    if (s.country) byCoun[s.country] = (byCoun[s.country] || 0) + 1;
  });

  const base = {
    events_total:      0,
    users_total:       subs.length,
    users_active_7d:   0,
    users_active_30d:  0,
    subscribed:        subs.length,
    unsubscribed:      0,
    last_event_at:     null,
    by_language:       byLang,
    by_country:        byCoun,
    by_hour_utc:       Array(24).fill(0),
    by_dow_utc:        Array(7).fill(0),
    by_command:        {},
    analytics_enabled: project.bot?.analytics_enabled ?? true,
  };

  const saved = readAnalyticsSummary(project.name);
  if (saved) {
    if (saved.events_total)            base.events_total       = saved.events_total;
    if (saved.users_total)             base.users_total        = Math.max(base.users_total, saved.users_total);
    if (saved.users_active_7d  != null) base.users_active_7d  = saved.users_active_7d;
    if (saved.users_active_30d != null) base.users_active_30d = saved.users_active_30d;
    if (saved.subscribed)              base.subscribed         = saved.subscribed;
    if (saved.unsubscribed)            base.unsubscribed       = saved.unsubscribed;
    if (saved.last_event_at)           base.last_event_at      = saved.last_event_at;
    if (saved.by_language)             base.by_language        = saved.by_language;
    if (saved.by_country_guess)        base.by_country         = saved.by_country_guess;
    if (saved.by_hour_utc)             base.by_hour_utc        = saved.by_hour_utc;
    if (saved.by_dow_utc)              base.by_dow_utc         = saved.by_dow_utc;
    if (saved.by_command)              base.by_command         = saved.by_command;
  }

  return base;
};

// ── HTML shell ────────────────────────────────────────────────────────────────
// Minimal HTML + CSS. All JS is served from /hub/webapp-client.js

const CSS = [
  '*{box-sizing:border-box;margin:0;padding:0}',
  'html,body{height:100%;background:var(--tg-theme-bg-color,#0f0f0f);color:var(--tg-theme-text-color,#f0f0f0);font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}',
  'a{color:var(--tg-theme-link-color,#60a5fa);text-decoration:none}',
  '#root{padding:16px 16px 72px}',
  // Typography
  '.ey{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#555;margin-bottom:18px}',
  'h1{font-size:24px;font-weight:800;letter-spacing:-.03em;line-height:1.1;margin-bottom:4px}',
  '.lead{font-size:13px;color:#555;margin-bottom:20px}',
  '.divider{border:none;border-top:1px solid rgba(255,255,255,.07);margin:18px 0}',
  '.muted{font-size:12px;color:#555;line-height:1.5}',
  // Layout
  '.sec{margin-bottom:4px}',
  '.sec-title{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#444;margin-bottom:10px;font-weight:600}',
  '.back-top{padding-top:50px}',
  // Cards
  '.card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px;margin-bottom:10px}',
  '.card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:14px;font-weight:700}',
  // Status indicators
  '.dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex-shrink:0}',
  '.dot.off{background:#444}',
  '.tag{font-size:10px;letter-spacing:.07em;text-transform:uppercase;padding:2px 7px;border-radius:4px;background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.2)}',
  '.tag.off{background:rgba(255,255,255,.04);color:#444;border-color:rgba(255,255,255,.07)}',
  '.tag.blue{background:rgba(96,165,250,.1);color:#60a5fa;border-color:rgba(96,165,250,.2)}',
  // Rows
  '.row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)}',
  '.row:last-child{border-bottom:none}',
  '.rk{font-size:12px;color:#555;flex-shrink:0;width:88px}',
  '.rv{font-size:12px;color:#aaa;word-break:break-all;flex:1}',
  // Buttons
  '.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}',
  '.btn{font-size:13px;font-weight:600;padding:8px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#aaa;cursor:pointer;white-space:nowrap;text-align:center}',
  '.btn:active{opacity:.6}',
  '.btn-prim{background:#fff;color:#000;border-color:#fff}',
  '.btn-prim:active{background:#ddd}',
  '.btn-full{width:100%;display:block;padding:11px}',
  '.btn-ghost{border-color:rgba(255,255,255,.12);color:#888}',
  '.btn-blue{border-color:rgba(96,165,250,.3);color:#60a5fa}',
  '.btn-danger{border-color:rgba(248,113,113,.3);color:#f87171}',
  // Inputs
  'input[type=text],input[type=url],textarea{width:100%;background:#111;border:1px solid rgba(255,255,255,.1);color:#f0f0f0;padding:9px 12px;border-radius:8px;font-size:13px;margin-bottom:8px;font-family:inherit;resize:vertical}',
  'input:focus,textarea:focus{outline:none;border-color:rgba(255,255,255,.25)}',
  // Toggle
  '.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0}',
  '.toggle{width:44px;height:24px;border-radius:12px;background:#333;position:relative;cursor:pointer;flex-shrink:0;border:none;outline:none;transition:background .15s}',
  '.toggle.on{background:#4ade80}',
  '.toggle::after{content:\'\';position:absolute;width:18px;height:18px;border-radius:9px;background:#fff;top:3px;left:3px;transition:left .15s}',
  '.toggle.on::after{left:23px}',
  // Webhook log table
  '.log-tbl{width:100%;font-size:11px;border-collapse:collapse;margin-top:6px}',
  '.log-tbl td{padding:4px 5px;border-bottom:1px solid rgba(255,255,255,.04)}',
  '.s-ok{color:#4ade80}.s-err{color:#f87171}.s-time{color:#444}',
  // Project list (SAP)
  '.proj-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer}',
  '.proj-row:last-child{border-bottom:none}',
  '.proj-row:active{opacity:.6}',
  '.proj-name{font-size:14px;font-weight:700}',
  '.proj-meta{font-size:12px;color:#555;margin-top:1px}',
  '.chevron{color:#333;font-size:18px}',
  '.empty{text-align:center;padding:40px 16px;color:#333;font-size:14px}',
  // Stat boxes
  '.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}',
  '.stat-grid-4{grid-template-columns:repeat(4,1fr)}',
  '.stat-box{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:10px 12px;text-align:center}',
  '.stat-n{font-size:22px;font-weight:800;letter-spacing:-.02em}',
  '.stat-l{font-size:10px;color:#444;letter-spacing:.06em;text-transform:uppercase;margin-top:2px}',
  // Analytics: language/country bars
  '.two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px}',
  '.mini-title{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#444;margin-bottom:5px}',
  '.bar-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px}',
  '.bar-label{color:#666;width:44px;flex-shrink:0}',
  '.bar-track{flex:1;height:5px;background:rgba(255,255,255,.07);border-radius:3px;overflow:hidden}',
  '.bar-fill{height:100%;background:#4ade80;border-radius:3px}',
  '.bar-fill-purple{background:#a78bfa}',
  '.bar-n{color:#555;width:24px;text-align:right;flex-shrink:0}',
  // Analytics: peak hours chart
  '.hour-chart{display:flex;align-items:flex-end;gap:2px;height:48px;margin-top:4px}',
  '.hour-bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;height:100%}',
  '.hour-bar{width:100%;background:rgba(74,222,128,.4);border-radius:2px 2px 0 0;min-height:3px}',
  '.hour-bar-top{background:#4ade80}',
  '.hour-label{font-size:8px;color:#333;margin-top:2px;white-space:nowrap}',
  // Analytics: day-of-week chart
  '.dow-chart{display:flex;align-items:flex-end;gap:4px;height:44px;margin-top:4px}',
  '.dow-bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;height:100%}',
  '.dow-bar{width:100%;background:rgba(96,165,250,.5);border-radius:2px 2px 0 0;min-height:3px}',
  '.dow-label{font-size:9px;color:#444;margin-top:2px}',
  // Analytics: commands list + broadcast
  '.cmd-list{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);border-radius:8px;padding:4px 12px;margin-top:4px}',
  '.broadcast-area{margin-top:10px}',
  // Toast
  '.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.9);border:1px solid rgba(255,255,255,.15);color:#f0f0f0;padding:8px 18px;border-radius:20px;font-size:13px;z-index:999;pointer-events:none;opacity:0;transition:opacity .18s;white-space:nowrap}',
  '.toast.show{opacity:1}',
  // Footer + back nav
  'footer{position:fixed;bottom:0;left:0;right:0;height:50px;background:var(--tg-theme-bg-color,#0f0f0f);border-top:1px solid rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;font-size:10px;color:#2a2a2a;font-family:ui-monospace,monospace;letter-spacing:.05em}',
  '.back-btn{display:none;position:fixed;top:0;left:0;right:0;height:42px;background:var(--tg-theme-bg-color,#0f0f0f);border-bottom:1px solid rgba(255,255,255,.07);align-items:center;padding:0 14px;gap:8px;font-size:14px;cursor:pointer;z-index:100}',
  '.back-btn.show{display:flex}',
].join('');

const renderShell = () =>
  `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Hub</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>${CSS}</style>
</head><body>
<div id="back-nav" class="back-btn"><span style="font-size:20px">&#8249;</span><span id="back-label">back</span></div>
<div id="root"><div class="empty">loading&hellip;</div></div>
<footer>hub &middot; hub.labs.co &middot; v0.3</footer>
<div id="toast" class="toast"></div>
<script src="/hub/webapp-client.js"></script>
</body></html>`;

// ── Route mounting ────────────────────────────────────────────────────────────

export function mountWebAppRoutes(app, ctx) {
  _ctx = ctx;

  // State
  app.get('/hub/api/state', (req, res) => {
    const parsed = parseToken(req);
    if (!parsed) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const { tier, token } = parsed;

    if (tier === 'sap') {
      if (token !== readSAP()) return res.status(401).json({ ok: false, error: 'unauthorized' });
      return res.json(buildSAPState());
    }
    if (tier === 'pap') {
      const p = ctx.modules.drafts?.findProjectByPAP(token);
      if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
      return res.json(buildPAPState(p));
    }
    if (tier === 'aap') {
      const hit = ctx.modules.drafts?.findProjectAndAAPByAAPToken(token);
      if (!hit) return res.status(404).json({ ok: false, error: 'aap_not_found' });
      return res.json(buildAAPState(hit.project, hit.aap));
    }
    return res.status(400).json({ ok: false, error: 'unknown_tier' });
  });

  // Analytics
  app.get('/hub/api/analytics', (req, res) => {
    const p = authPAP(req, ctx);
    if (!p) return res.status(401).json({ ok: false, error: 'unauthorized' });
    return res.json(buildAnalytics(p));
  });

  // Analytics download (raw JSONL)
  app.get('/hub/api/analytics/download', (req, res) => {
    const p = authPAP(req, ctx);
    if (!p) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const dataDir = ctx.config.dataDir || '/var/lib/hub';
    const fp = path.join(dataDir, 'projects', p.name, 'analytics.jsonl');
    if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: 'no_data' });
    res.setHeader('Content-Disposition', `attachment; filename="${p.name}-analytics.jsonl"`);
    res.setHeader('Content-Type', 'application/jsonlines+json');
    fs.createReadStream(fp).pipe(res);
  });

  // Bot sync — push name/description/commands/menu-button to Telegram
  app.post('/hub/api/bot/sync', async (req, res) => {
    const p = authPAP(req, ctx);
    if (!p) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!p.bot?.token) return res.status(400).json({ ok: false, error: 'no_bot' });

    const tg = async (method, params) => {
      const r = await fetch(`https://api.telegram.org/bot${p.bot.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(params),
      });
      return r.json();
    };

    // Load optional bot.json from project live dir
    let botJson = {};
    try {
      const bpath = path.join(ctx.config.dataDir || '/var/lib/hub', 'projects', p.name, 'live', 'bot.json');
      if (fs.existsSync(bpath)) botJson = JSON.parse(fs.readFileSync(bpath, 'utf8'));
    } catch {}

    const results = {};
    try {
      if (botJson.name)        results.name        = (await tg('setMyName',        { name: botJson.name })).ok;
      if (botJson.description) results.description = (await tg('setMyDescription', { description: botJson.description })).ok;
      if (botJson.commands?.length) {
        const cmds = botJson.commands
          .filter(c => c.command && c.description)
          .map(c => ({ command: c.command.replace(/^\//, ''), description: c.description }));
        if (cmds.length) results.commands = (await tg('setMyCommands', { commands: cmds, scope: { type: 'all_private_chats' } })).ok;
      }
      // Always set menu button to webapp
      const papHex   = p.pap?.token?.replace(/^pap_/, '');
      const sn       = ctx.config.serverNumber;
      const base     = ctx.config.publicBase;
      const waUrl    = `${base}/hub/webapp?token=pass_${sn}_project_${papHex}`;
      results.menu_button = (await tg('setChatMenuButton', {
        menu_button: { type: 'web_app', text: botJson.menu_button_text || 'Dashboard', web_app: { url: waUrl } },
      })).ok;
      return res.json({ ok: true, results });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Broadcast
  app.post('/hub/api/broadcast', async (req, res) => {
    const p = authPAP(req, ctx);
    if (!p) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!p.bot?.token) return res.status(400).json({ ok: false, error: 'no_bot' });

    const message = String(req.body?.message || '').trim();
    if (!message) return res.json({ ok: true, sent: 0, skipped: 0, reason: 'no_message' });

    const subs = p.bot.subscribers || [];
    let sent = 0, skipped = 0;
    const dead = [];

    for (const sub of subs) {
      const chatId = sub.chat_id || sub.id;
      if (!chatId) { skipped++; continue; }
      try {
        const r    = await fetch(`https://api.telegram.org/bot${p.bot.token}/sendMessage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
        });
        const data = await r.json();
        if (data.ok) {
          sent++;
        } else if (data.error_code === 403 || data.error_code === 400) {
          dead.push(chatId); skipped++;
        } else {
          skipped++;
        }
      } catch { skipped++; }
    }

    if (dead.length) {
      p.bot.subscribers = subs.filter(s => !dead.includes(s.chat_id || s.id));
      ctx.modules.drafts?.saveState?.();
    }
    ctx.logger.info(`[broadcast] ${p.name}: sent=${sent} skipped=${skipped} pruned=${dead.length}`);
    return res.json({ ok: true, sent, skipped, pruned: dead.length });
  });

  // Webhook enable
  app.put('/drafts/project/bot/webhook', async (req, res) => {
    const p = authPAP(req, ctx);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    if (!p.bot?.token) return res.status(400).json({ ok: false, error: 'no_bot' });
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'url_required' });
    try {
      const r = await fetch(`https://api.telegram.org/bot${p.bot.token}/setWebhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const tg = await r.json();
      if (!tg.ok) throw new Error(tg.description);
      p.bot.webhook_url = url;
      ctx.modules.drafts?.saveState?.();
      return res.json({ ok: true });
    } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  });

  // Webhook disable
  app.delete('/drafts/project/bot/webhook', async (req, res) => {
    const p = authPAP(req, ctx);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    if (!p.bot?.token) return res.status(400).json({ ok: false, error: 'no_bot' });
    try {
      await fetch(`https://api.telegram.org/bot${p.bot.token}/deleteWebhook`, { method: 'POST' });
      p.bot.webhook_url = null;
      ctx.modules.drafts?.saveState?.();
      return res.json({ ok: true });
    } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  });

  // GitHub autosync toggle
  app.put('/drafts/project/github-autosync', (req, res) => {
    const p = authPAP(req, ctx);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    p.github_autosync = !!(req.body?.enabled);
    ctx.modules.drafts?.saveState?.();
    return res.json({ ok: true, enabled: p.github_autosync });
  });

  // Static client JS
  app.get('/hub/webapp-client.js', (req, res) => {
    const fp = path.join(path.dirname(new URL(import.meta.url).pathname), 'webapp-client.js');
    res.type('application/javascript').sendFile(fp);
  });

  // HTML shell
  app.get('/hub/webapp', (req, res) => {
    res.type('html').send(renderShell());
  });

  ctx.logger.info('[webapp] v0.3 routes mounted');
}
