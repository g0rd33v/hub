// modules/drafts/webapp.js
// Hub Telegram Mini App
//
// Routes:
//   GET /hub/state?token=<pass>     — return tier + data for web app
//   GET /hub/webapp                  — HTML Mini App shell
//
// The Mini App opens via web_app button in Telegram.
// It loads /hub/state, determines tier (sap/pap/aap), renders the right view.

import fs   from 'fs';
import path from 'path';

let _ctx;

function readSAP() {
  try { return fs.readFileSync('/etc/hub/sap.token','utf8').trim(); } catch { return ''; }
}

function resolveToken(raw) {
  // pass_N_server_HEX → { tier:'sap', token:HEX }
  // pass_N_project_HEX → { tier:'pap', token:'pap_'+HEX }
  // pass_N_agent_HEX → { tier:'aap', token:'aap_'+HEX }
  // pap_HEX → { tier:'pap', token }
  // aap_HEX → { tier:'aap', token }
  // plain HEX (16 chars) → { tier:'sap', token }
  if (!raw) return null;
  const newFmt = raw.match(/^pass_(\d+)_([a-z][a-z0-9]*)_(.+)$/);
  if (newFmt) {
    const role = newFmt[2], hex = newFmt[3];
    if (role === 'server')  return { tier: 'sap', token: hex };
    if (role === 'project') return { tier: 'pap', token: 'pap_'+hex };
    if (role === 'agent')   return { tier: 'aap', token: 'aap_'+hex };
    return null;
  }
  if (raw.startsWith('pap_')) return { tier: 'pap', token: raw };
  if (raw.startsWith('aap_')) return { tier: 'aap', token: raw };
  if (/^[0-9a-f]{12,64}$/i.test(raw)) return { tier: 'sap', token: raw };
  return null;
}

function sapData() {
  const st   = _ctx.modules.drafts.getState();
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  return {
    tier: 'sap',
    base,
    server_number: sn,
    version: _ctx.config.version || '0.2.0',
    uptime_sec: Math.floor(process.uptime()),
    projects: st.projects.map(p => ({
      name: p.name,
      description: p.description || p.name,
      pap_url: p.pap?.token ? `${base}/signin/pass_${sn}_project_${p.pap.token.replace(/^pap_/,'')}` : null,
      webapp_pap_url: p.pap?.token ? `${base}/hub/webapp?token=pass_${sn}_project_${p.pap.token.replace(/^pap_/,'')}` : null,
      live_url: `${base}/${p.name}/`,
      bot: p.bot ? { username: p.bot.bot_username, mode: p.bot.webhook_url?'webhook':'polling', subscribers: (p.bot.subscribers||[]).length } : null,
      versions: 0, // loaded separately if needed
    })),
  };
}

function papData(project) {
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  const papSecret = project.pap?.token?.replace(/^pap_/,'');
  const analytics = _ctx.modules.analytics?.getProjectSummary?.(project.name) || null;
  return {
    tier: 'pap',
    base,
    name: project.name,
    description: project.description || project.name,
    live_url: `${base}/${project.name}/`,
    pap_url: papSecret ? `${base}/signin/pass_${sn}_project_${papSecret}` : null,
    webapp_url: papSecret ? `${base}/hub/webapp?token=pass_${sn}_project_${papSecret}` : null,
    bot: project.bot ? {
      username:    project.bot.bot_username,
      mode:        project.bot.webhook_url ? 'webhook' : 'polling',
      webhook_url: project.bot.webhook_url || null,
      webhook_log: (project.bot.webhook_log || []).slice(0, 10),
      subscribers: (project.bot.subscribers || []).length,
      analytics_enabled: project.bot.analytics_enabled !== false,
    } : null,
    versions: [],  // filled by listVersions in route handler
    github_repo: project.github_repo || null,
    github_autosync: project.github_autosync || false,
    aaps: (project.aaps || []).filter(a => !a.revoked).map(a => ({
      id: a.id, name: a.name, branch: a.branch,
      webapp_url: `${base}/hub/webapp?token=pass_${sn}_agent_${a.token.replace(/^aap_/,'')}`,
    })),
    analytics,
  };
}

function aapData(project, aap) {
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  return {
    tier: 'aap',
    base,
    project_name: project.name,
    project_description: project.description || project.name,
    live_url: `${base}/${project.name}/`,
    branch: aap.branch,
    aap_name: aap.name || aap.id,
    aap_id: aap.id,
    pap_url: null, // AAP doesn’t know PAP URL
  };
}

export function mountWebAppRoutes(app, ctx) {
  _ctx = ctx;
  const { makeAuthMiddleware } = await import('../../hub/credentials.js');

  // GET /hub/state?token=... — returns JSON state for Mini App
  app.get('/hub/state', async (req, res) => {
    const raw = req.query.token || '';
    const parsed = resolveToken(raw);
    if (!parsed) return res.status(400).json({ ok: false, error: 'invalid_token' });

    const { tier, token } = parsed;
    const sap = readSAP();

    if (tier === 'sap') {
      if (token !== sap) return res.status(403).json({ ok: false, error: 'forbidden' });
      return res.json({ ok: true, ...sapData() });
    }
    if (tier === 'pap') {
      const p = ctx.modules.drafts.findProjectByPAP(token);
      if (!p) return res.status(404).json({ ok: false, error: 'not_found' });
      // Load versions
      const { listVersions } = await import('./git.js');
      const versions = await listVersions(p.name).catch(() => []);
      const d = papData(p);
      d.versions = versions;
      return res.json({ ok: true, ...d });
    }
    if (tier === 'aap') {
      const hit = ctx.modules.drafts.findProjectAndAAPByAAPToken(token);
      if (!hit) return res.status(404).json({ ok: false, error: 'not_found' });
      return res.json({ ok: true, ...aapData(hit.project, hit.aap) });
    }
    return res.status(400).json({ ok: false, error: 'unknown_tier' });
  });

  // GET /hub/webapp — serves the Mini App HTML shell
  app.get('/hub/webapp', (req, res) => {
    const token = req.query.token || '';
    const base  = ctx.config.publicBase;
    res.type('html').send(renderWebAppShell(token, base));
  });
}

// ————————————————————————————————————————————————————————————————————————————————
// HTML shell + client-side SPA
// ————————————————————————————————————————————————————————————————————————————————

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function renderWebAppShell(token, base) {
  const stateUrl = `${base}/hub/state?token=${encodeURIComponent(token)}`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Hub</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{
  --bg:#000;--card:#0d0d0d;--card-hi:#141414;
  --border:rgba(255,255,255,.07);--border-hi:rgba(255,255,255,.15);
  --text:#f0f0f0;--muted:#666;--faint:#333;
  --green:#4ade80;--red:#f87171;--blue:#60a5fa;--yellow:#fbbf24;
  --r:10px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{
  background:var(--bg);color:var(--text);
  font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;
  font-size:15px;line-height:1.6;
  -webkit-font-smoothing:antialiased;
  padding-bottom:env(safe-area-inset-bottom,16px);
}
a{color:inherit;text-decoration:none}
#root{padding:20px 16px 40px;max-width:640px;margin:0 auto}
.eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--muted);margin-bottom:20px}
h1{font-size:28px;font-weight:800;letter-spacing:-.035em;line-height:1.05;margin-bottom:6px}
.lead{font-size:14px;color:var(--muted);margin-bottom:24px}
.divider{border:none;border-top:1px solid var(--border);margin:20px 0}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);
  padding:18px;margin-bottom:14px}
.card:last-child{margin-bottom:0}
.card h3{font-size:11px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--muted);margin-bottom:14px;display:flex;align-items:center;gap:6px}
.card h3 .dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex-shrink:0}
.card h3 .dot.on{background:var(--green)}
.row{display:flex;justify-content:space-between;align-items:center;
  padding:8px 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:none}
.row-key{font-size:13px;color:var(--muted)}
.row-val{font-size:13px;font-family:ui-monospace,monospace;color:var(--text);text-align:right;word-break:break-all;max-width:60%}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
btn,.btn{display:inline-flex;align-items:center;justify-content:center;
  font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;
  border:1px solid var(--border);background:transparent;color:var(--text);
  cursor:pointer;white-space:nowrap;text-decoration:none}
.btn:hover,.btn:active{background:rgba(255,255,255,.06)}
.btn-primary{background:var(--text);color:#000;border-color:var(--text)}
.btn-primary:hover{background:#ccc}
.btn-danger{color:var(--red);border-color:rgba(248,113,113,.25)}
.btn-danger:hover{background:rgba(248,113,113,.08)}
.btn-sm{font-size:11px;padding:5px 10px;border-radius:6px}
.tag{font-size:10px;letter-spacing:.07em;text-transform:uppercase;
  padding:2px 7px;border-radius:4px;border:1px solid;white-space:nowrap}
.tag-green{background:rgba(74,222,128,.1);color:var(--green);border-color:rgba(74,222,128,.2)}
.tag-gray{background:rgba(255,255,255,.04);color:var(--muted);border-color:var(--border)}
.tag-blue{background:rgba(96,165,250,.1);color:var(--blue);border-color:rgba(96,165,250,.2)}
.tag-yellow{background:rgba(251,191,36,.1);color:var(--yellow);border-color:rgba(251,191,36,.2)}
input[type=text],input[type=url]{
  width:100%;background:var(--card-hi);border:1px solid var(--border);
  border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text);
  margin:8px 0;outline:none}
input:focus{border-color:var(--border-hi)}
.toggle-row{display:flex;align-items:center;justify-content:space-between;margin:8px 0}
.toggle-label{font-size:13px}
.toggle{position:relative;width:40px;height:22px}
.toggle input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:#333;border-radius:11px;cursor:pointer;transition:.2s}
.toggle-slider::before{content:"";position:absolute;height:16px;width:16px;left:3px;bottom:3px;
  background:#fff;border-radius:50%;transition:.2s}
.toggle input:checked+.toggle-slider{background:#4ade80}
.toggle input:checked+.toggle-slider::before{transform:translateX(18px)}
.log-table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
.log-table td{padding:4px 6px;border-bottom:1px solid var(--faint)}
.log-time{color:var(--muted);white-space:nowrap}
.log-status.ok{color:var(--green)}
.log-status.err{color:var(--red)}
.project-btn{display:flex;align-items:center;justify-content:space-between;
  padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer}
.project-btn:last-child{border-bottom:none}
.project-btn:active{opacity:.7}
.project-name{font-size:15px;font-weight:600}
.project-sub{font-size:12px;color:var(--muted);margin-top:2px}
.back-btn{display:flex;align-items:center;gap:6px;font-size:13px;
  color:var(--muted);cursor:pointer;margin-bottom:20px;width:fit-content}
.back-btn:active{opacity:.7}
.analytics-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}
.stat-box{background:var(--card-hi);border-radius:8px;padding:12px}
.stat-num{font-size:22px;font-weight:800;letter-spacing:-.03em}
.stat-lbl{font-size:11px;color:var(--muted);margin-top:2px}
.empty{text-align:center;padding:32px;color:var(--faint);font-size:14px}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
  background:var(--text);color:#000;padding:8px 18px;border-radius:20px;
  font-size:13px;font-weight:600;pointer-events:none;
  opacity:0;transition:opacity .2s;z-index:999}
.toast.show{opacity:1}
</style>
</head><body>
<div id="root"><div class="empty">loading…</div></div>
<div class="toast" id="toast"></div>
<script>
(function(){
'use strict';
const BASE     = ${JSON.stringify(base)};
const STATE_URL = ${JSON.stringify(stateUrl)};
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const root = document.getElementById('root');
const toastEl = document.getElementById('toast');
let toastTimer;

function toast(msg, type) {
  toastEl.textContent = msg;
  toastEl.style.background = type==='err' ? '#f87171' : '#f0f0f0';
  toastEl.style.color = '#000';
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

function timeAgo(iso) {
  if (!iso) return '';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return Math.floor(d/1000)+'s';
  if (d < 3600000) return Math.floor(d/60000)+'m';
  if (d < 86400000) return Math.floor(d/3600000)+'h';
  return Math.floor(d/86400000)+'d';
}

// —— State machine ——
let _data = null;
let _sapNavStack = false;

async function load() {
  try {
    _data = await api('GET', STATE_URL);
    if (!_data.ok) { root.innerHTML = '<div class="empty">error: '+esc(_data.error||'unknown')+'</div>'; return; }
    if (_data.tier === 'sap') renderSAP(_data);
    else if (_data.tier === 'pap') renderPAP(_data);
    else if (_data.tier === 'aap') renderAAP(_data);
    else root.innerHTML = '<div class="empty">unknown tier</div>';
  } catch(e) {
    root.innerHTML = '<div class="empty">failed to load: '+esc(e.message)+'</div>';
  }
}

// —— SAP ——
function renderSAP(d) {
  let h = '';
  h += '<div class="eyebrow">Hub · Server · SAP</div>';
  h += '<h1>Dashboard.</h1>';
  h += '<p class="lead">'+(d.projects.length)+' project'+(d.projects.length!==1?'s':'')+' · up '+Math.floor(d.uptime_sec/60)+'m</p>';

  if (!d.projects.length) {
    h += '<div class="empty">No projects. Create one with /new in the bot.</div>';
  } else {
    h += '<div class="card">';
    h += '<h3><span class="dot on"></span>Projects</h3>';
    for (const p of d.projects) {
      const botTag = p.bot ? ' · @'+p.bot.username : '';
      h += '<div class="project-btn" data-webapp="'+esc(p.webapp_pap_url||'')+'" data-name="'+esc(p.name)+'">';
      h += '<div><div class="project-name">'+esc(p.description)+'</div>';
      h += '<div class="project-sub">'+esc(p.name)+botTag+'</div></div>';
      h += '<span class="tag '+(p.bot?'tag-green':'tag-gray')+'">'+(p.bot?p.bot.mode:'no bot')+'</span>';
      h += '</div>';
    }
    h += '</div>';
  }

  h += '<div class="divider"></div>';
  h += '<div class="card">';
  h += '<h3><span class="dot"></span>Create project</h3>';
  h += '<input type="text" id="newName" placeholder="project-name" autocomplete="off" autocorrect="off" spellcheck="false"/>';
  h += '<input type="text" id="newDesc" placeholder="Description (optional)"/>';
  h += '<div class="actions"><button class="btn btn-primary" id="createBtn">Create</button></div>';
  h += '</div>';

  root.innerHTML = h;

  // Wire: open project dashboard
  root.querySelectorAll('.project-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const webappUrl = btn.getAttribute('data-webapp');
      const name = btn.getAttribute('data-name');
      if (!webappUrl) return;
      if (tg) {
        tg.openLink(webappUrl);
      } else {
        // Fallback: load PAP inline
        try {
          _sapNavStack = true;
          const pd = await api('GET', webappUrl.replace('/hub/webapp?token=', '/hub/state?token=').replace(new URL(webappUrl).origin, '').replace('/hub/webapp', BASE+'/hub/state'));
          // More robust: reconstruct state URL
          const stateForProject = BASE+'/hub/state?token='+encodeURIComponent(new URL(webappUrl).searchParams.get('token'));
          const r = await api('GET', stateForProject);
          if (r.ok) renderPAP(r);
        } catch(e) { toast('failed: '+e.message, 'err'); }
      }
    });
  });

  document.getElementById('createBtn').addEventListener('click', async () => {
    const name = document.getElementById('newName').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g,'');
    const description = document.getElementById('newDesc').value.trim();
    if (!name) { toast('name required', 'err'); return; }
    try {
      const out = await api('POST', BASE+'/drafts/projects', { name, description });
      if (!out.ok) { toast('failed: '+(out.error||'?'), 'err'); return; }
      toast('created ✓');
      setTimeout(load, 600);
    } catch(e) { toast('error: '+e.message, 'err'); }
  });
}

// —— PAP ——
function renderPAP(d) {
  const PAP_TOKEN = d.pap_url ? new URL(d.pap_url).pathname.split('pass_')[1] ? 'pap_'+new URL(d.pap_url).pathname.split('_project_')[1] : '' : '';
  // Extract PAP from webapp_url token instead
  const webappToken = new URLSearchParams(new URL(STATE_URL).search).get('token') ||
    new URL(d.webapp_url||STATE_URL.replace('/hub/state','/hub/webapp')).searchParams?.get('token') || '';

  let h = '';
  if (_sapNavStack) {
    h += '<div class="back-btn" id="backBtn">← back</div>';
  }
  h += '<div class="eyebrow">Hub · '+esc(d.name)+' · PAP</div>';
  h += '<h1>'+esc(d.description)+'</h1>';
  h += '<p class="lead"><a href="'+esc(d.live_url)+'" target="_blank">'+esc(d.live_url)+'</a>';
  if (d.versions.length) h += ' · v'+d.versions[d.versions.length-1];
  h += ' · '+(d.aaps.length)+' contributor'+(d.aaps.length!==1?'s':'');
  h += '</p>';

  // Bot card
  h += '<div class="card" id="botCard">';
  if (d.bot) {
    h += '<h3><span class="dot on"></span>Bot &nbsp;<span class="tag tag-green">'+esc(d.bot.mode)+'</span></h3>';
    h += '<div class="row"><span class="row-key">username</span><span class="row-val">@'+esc(d.bot.username)+'</span></div>';
    h += '<div class="row"><span class="row-key">subscribers</span><span class="row-val">'+d.bot.subscribers+'</span></div>';
    h += '<div class="row"><span class="row-key">mode</span><span class="row-val">'+esc(d.bot.mode)+'</span></div>';
    h += '<div class="actions">';
    h += '<a href="https://t.me/'+esc(d.bot.username)+'" target="_blank" class="btn btn-primary">Open in Telegram</a>';
    h += '<button class="btn btn-danger" id="unlinkBotBtn">Unlink</button>';
    h += '</div>';
  } else {
    h += '<h3><span class="dot"></span>Bot</h3>';
    h += '<div class="empty" style="padding:12px 0 4px">No bot linked.</div>';
    h += '<input type="text" id="botTokenInput" placeholder="Paste token from @BotFather" autocorrect="off"/>';
    h += '<div class="actions"><button class="btn btn-primary" id="linkBotBtn">Link bot</button></div>';
  }
  h += '</div>';

  // Webhook card (only if bot linked)
  if (d.bot) {
    h += '<div class="card" id="webhookCard">';
    if (d.bot.mode === 'webhook') {
      h += '<h3><span class="dot on"></span>Webhook</h3>';
      h += '<div class="row"><span class="row-key">URL</span><span class="row-val">'+esc(d.bot.webhook_url)+'</span></div>';
      if (d.bot.webhook_log.length) {
        h += '<table class="log-table">';
        for (const e of d.bot.webhook_log) {
          const ok = e.status >= 200 && e.status < 300;
          h += '<tr><td class="log-time">'+timeAgo(e.at)+'</td>';
          h += '<td class="log-status '+(ok?'ok':'err')+'">'+(e.status||e.error)+'</td>';
          h += '<td>'+Math.round(e.latency_ms||0)+'ms</td></tr>';
        }
        h += '</table>';
      } else {
        h += '<div class="empty" style="padding:8px 0">no calls yet</div>';
      }
      h += '<div class="actions"><button class="btn btn-danger" id="disableWebhookBtn">Switch to polling</button></div>';
    } else {
      h += '<h3><span class="dot"></span>Webhook</h3>';
      h += '<div class="empty" style="padding:8px 0 4px">Using long polling.</div>';
      h += '<input type="url" id="webhookInput" placeholder="https://your-app.vercel.app/webhook"/>';
      h += '<div class="actions"><button class="btn btn-primary" id="enableWebhookBtn">Enable webhook</button></div>';
    }
    h += '</div>';
  }

  // Analytics card
  if (d.bot?.analytics_enabled && d.analytics) {
    const s = d.analytics;
    h += '<div class="card">';
    h += '<h3><span class="dot on"></span>Analytics</h3>';
    h += '<div class="analytics-grid">';
    h += '<div class="stat-box"><div class="stat-num">'+(s.total_users||0)+'</div><div class="stat-lbl">users</div></div>';
    h += '<div class="stat-box"><div class="stat-num">'+(s.total_messages||0)+'</div><div class="stat-lbl">messages</div></div>';
    h += '</div>';
    if (s.top_languages?.length) {
      h += '<div style="margin-top:12px;font-size:12px;color:#666">';
      h += s.top_languages.slice(0,5).map(l => esc(l.lang)+' '+l.count).join(' · ');
      h += '</div>';
    }
    h += '</div>';
  } else if (d.bot) {
    h += '<div class="card" id="analyticsCard">';
    h += '<h3><span class="dot"></span>Analytics</h3>';
    h += '<div class="empty" style="padding:8px 0">loading…</div>';
    h += '</div>';
  }

  // Versions card
  if (d.versions.length) {
    h += '<div class="card">';
    h += '<h3><span class="dot"></span>Versions</h3>';
    for (const v of [...d.versions].reverse().slice(0,6)) {
      const isLive = v === d.versions[d.versions.length-1];
      h += '<div class="row"><span class="row-key">v'+v+'</span>';
      h += '<span class="row-val">'+(isLive?'<span class="tag tag-green">live</span>':'<a href="'+esc(d.live_url)+'v/'+v+'/" target="_blank" class="btn btn-sm">view</a>')+'</span></div>';
    }
    h += '<div class="actions"><button class="btn btn-primary" id="promoteBtn">Promote draft to live</button></div>';
    h += '</div>';
  }

  // Build card
  h += '<div class="card">';
  h += '<h3><span class="dot"></span>Build loop</h3>';
  h += '<div class="row"><span class="row-key">POST /drafts/upload</span><span class="row-val">{filename, content}</span></div>';
  h += '<div class="row"><span class="row-key">POST /drafts/commit</span><span class="row-val">{message}</span></div>';
  h += '<div class="row"><span class="row-key">POST /drafts/promote</span><span class="row-val"></span></div>';
  h += '<div class="actions">';
  h += '<a href="'+esc(d.live_url)+'" class="btn btn-primary" target="_blank">Open live</a>';
  h += '</div></div>';

  // Contributors
  if (d.aaps.length) {
    h += '<div class="card">';
    h += '<h3><span class="dot"></span>Contributors ('+d.aaps.length+')</h3>';
    for (const a of d.aaps) {
      h += '<div class="row"><span class="row-key">'+esc(a.name)+'</span>';
      h += '<span class="row-val"><a href="'+esc(a.webapp_url)+'" class="btn btn-sm" target="_blank">open</a></span></div>';
    }
    h += '</div>';
  }

  // This link
  h += '<div class="card">';
  h += '<h3><span class="dot"></span>This link</h3>';
  h += '<div style="font-size:11px;font-family:ui-monospace,monospace;color:var(--muted);word-break:break-all;margin-bottom:12px">'+esc(d.pap_url||d.webapp_url||'')+'</div>';
  h += '<div class="actions">';
  h += '<button class="btn" id="copyPapBtn">Copy PAP link</button>';
  h += '</div></div>';

  root.innerHTML = h;

  // Bind back
  document.getElementById('backBtn')?.addEventListener('click', () => {
    _sapNavStack = false;
    renderSAP(_data);
  });

  // Bot actions
  document.getElementById('linkBotBtn')?.addEventListener('click', async () => {
    const token = document.getElementById('botTokenInput').value.trim();
    if (!token) { toast('paste token first', 'err'); return; }
    try {
      const r = await api('PUT', BASE+'/drafts/project/bot', { token });
      if (r.ok) { toast('linked: @'+r.bot.bot_username); setTimeout(() => { load(); }, 700); }
      else toast('failed: '+(r.detail||r.error||'?'), 'err');
    } catch(e) { toast(e.message,'err'); }
  });

  document.getElementById('unlinkBotBtn')?.addEventListener('click', async () => {
    if (!confirm('Unlink bot?')) return;
    try {
      const r = await api('DELETE', BASE+'/drafts/project/bot');
      if (r.ok) { toast('unlinked'); setTimeout(load, 600); }
      else toast('failed: '+r.error, 'err');
    } catch(e) { toast(e.message,'err'); }
  });

  // Webhook actions
  document.getElementById('enableWebhookBtn')?.addEventListener('click', async () => {
    const url = document.getElementById('webhookInput').value.trim();
    if (!url) { toast('paste webhook URL first', 'err'); return; }
    try {
      const r = await api('PUT', BASE+'/drafts/project/webhook', { url });
      if (r.ok) { toast('webhook enabled'); setTimeout(load, 600); }
      else toast('failed: '+r.error, 'err');
    } catch(e) { toast(e.message,'err'); }
  });

  document.getElementById('disableWebhookBtn')?.addEventListener('click', async () => {
    if (!confirm('Switch to polling mode?')) return;
    try {
      const r = await api('DELETE', BASE+'/drafts/project/webhook');
      if (r.ok) { toast('switched to polling'); setTimeout(load, 600); }
      else toast('failed: '+r.error, 'err');
    } catch(e) { toast(e.message,'err'); }
  });

  // Promote
  document.getElementById('promoteBtn')?.addEventListener('click', async () => {
    try {
      const r = await api('POST', BASE+'/drafts/promote');
      if (r.ok) { toast('promoted to live ✓'); setTimeout(load, 600); }
      else toast('failed: '+(r.detail||r.error||'?'), 'err');
    } catch(e) { toast(e.message,'err'); }
  });

  // Copy PAP
  document.getElementById('copyPapBtn')?.addEventListener('click', () => {
    const url = d.pap_url || d.webapp_url || '';
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('copied ✓'));
    else { toast(url); }
  });

  // Load analytics async
  if (d.bot && !d.analytics) {
    api('GET', BASE+'/drafts/project/analytics').then(r => {
      const card = document.getElementById('analyticsCard');
      if (!card) return;
      if (!r.ok || !r.summary) { card.querySelector('.empty').textContent = 'no data'; return; }
      const s = r.summary;
      let ah = '<h3><span class="dot on"></span>Analytics</h3>';
      ah += '<div class="analytics-grid">';
      ah += '<div class="stat-box"><div class="stat-num">'+(s.total_users||0)+'</div><div class="stat-lbl">users</div></div>';
      ah += '<div class="stat-box"><div class="stat-num">'+(s.total_messages||0)+'</div><div class="stat-lbl">messages</div></div>';
      ah += '</div>';
      if (s.top_languages?.length) {
        ah += '<div style="margin-top:10px;font-size:12px;color:#666">';
        ah += s.top_languages.slice(0,5).map(l => esc(l.lang)+' '+l.count).join(' · ');
        ah += '</div>';
      }
      card.innerHTML = ah;
    }).catch(() => {});
  }
}

// —— AAP ——
function renderAAP(d) {
  let h = '';
  h += '<div class="eyebrow">Hub · '+esc(d.project_name)+' · AAP</div>';
  h += '<h1>'+esc(d.aap_name)+'</h1>';
  h += '<p class="lead">Contributor on <a href="'+esc(d.live_url)+'" target="_blank">'+esc(d.project_name)+'</a></p>';
  h += '<div class="card">';
  h += '<h3><span class="dot"></span>Branch</h3>';
  h += '<div class="row"><span class="row-key">branch</span><span class="row-val">'+esc(d.branch)+'</span></div>';
  h += '</div>';
  h += '<div class="card">';
  h += '<h3><span class="dot"></span>Build loop</h3>';
  h += '<div class="row"><span class="row-key">POST /drafts/upload</span><span class="row-val">{filename, content}</span></div>';
  h += '<div class="row"><span class="row-key">POST /drafts/commit</span><span class="row-val">{message}</span></div>';
  h += '</div>';
  root.innerHTML = h;
}

load();
})();
</script>
</body></html>`;
}
