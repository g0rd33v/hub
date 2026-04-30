// modules/drafts/webapp.js
// Hub Telegram Mini App — /hub/state API + /hub/webapp shell
import fs   from 'fs';
import path from 'path';
import { listVersions } from './git.js';
import { parseBearer  } from '../../hub/credentials.js';

let _ctx;

function readSAP() {
  try { return fs.readFileSync('/etc/hub/sap.token','utf8').trim(); } catch { return ''; }
}

function resolveToken(raw) {
  if (!raw) return null;
  const n = raw.match(/^pass_(\d+)_([a-z][a-z0-9]*)_(.+)$/);
  if (n) {
    const role = n[2], hex = n[3];
    if (role === 'server')  return { tier:'sap', token: hex };
    if (role === 'project') return { tier:'pap', token:'pap_'+hex };
    if (role === 'agent')   return { tier:'aap', token:'aap_'+hex };
    return null;
  }
  if (raw.startsWith('pap_')) return { tier:'pap', token:raw };
  if (raw.startsWith('aap_')) return { tier:'aap', token:raw };
  if (/^[0-9a-f]{12,64}$/i.test(raw)) return { tier:'sap', token:raw };
  return null;
}

function requireAuth(req, res) {
  // For state endpoint auth comes from query token, handled inline
  return true;
}

function papTokenFromReq(req) {
  const bearer = parseBearer(req);
  if (bearer) return bearer;
  // Also accept ?pap_token= for GET requests from webapp
  return req.query.pap_token || null;
}

// —— State builders ——

function buildSAPData() {
  const st   = _ctx.modules.drafts.getState();
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  return {
    tier: 'sap',
    base, server_number: sn,
    version: '0.2.0',
    uptime_sec: Math.floor(process.uptime()),
    projects: st.projects.map(p => ({
      name:        p.name,
      description: p.description || p.name,
      live_url:    `${base}/${p.name}/`,
      pap_url:     p.pap?.token ? `${base}/signin/pass_${sn}_project_${p.pap.token.replace(/^pap_/,'')}` : null,
      webapp_pap_url: p.pap?.token ? `${base}/hub/webapp?token=pass_${sn}_project_${p.pap.token.replace(/^pap_/,'')}` : null,
      state_pap_url:  p.pap?.token ? `${base}/hub/state?token=pass_${sn}_project_${p.pap.token.replace(/^pap_/,'')}` : null,
      bot: p.bot ? {
        username:    p.bot.bot_username,
        mode:        p.bot.webhook_url ? 'webhook' : 'polling',
        subscribers: (p.bot.subscribers||[]).length,
      } : null,
    })),
  };
}

function buildPAPData(project, versions) {
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  const papSecret = project.pap?.token?.replace(/^pap_/,'');
  const analytics = _ctx.modules.analytics?.getProjectSummary?.(project.name) || null;
  return {
    tier: 'pap',
    base,
    name:        project.name,
    description: project.description || project.name,
    live_url:    `${base}/${project.name}/`,
    pap_url:     papSecret ? `${base}/signin/pass_${sn}_project_${papSecret}` : null,
    webapp_url:  papSecret ? `${base}/hub/webapp?token=pass_${sn}_project_${papSecret}` : null,
    pap_token:   project.pap?.token || null,
    bot: project.bot ? {
      username:         project.bot.bot_username,
      mode:             project.bot.webhook_url ? 'webhook' : 'polling',
      webhook_url:      project.bot.webhook_url || null,
      webhook_log:      (project.bot.webhook_log || []).slice(0, 10),
      subscribers:      (project.bot.subscribers || []).length,
      analytics_enabled: project.bot.analytics_enabled !== false,
    } : null,
    versions,
    github_repo:     project.github_repo     || null,
    github_autosync: project.github_autosync || false,
    aaps: (project.aaps||[]).filter(a=>!a.revoked).map(a => ({
      id: a.id, name: a.name, branch: a.branch,
      webapp_url: `${base}/hub/webapp?token=pass_${sn}_agent_${a.token.replace(/^aap_/,'')}`,
    })),
    analytics,
  };
}

function buildAAPData(project, aap) {
  const base = _ctx.config.publicBase;
  return {
    tier: 'aap',
    base,
    project_name:        project.name,
    project_description: project.description || project.name,
    live_url:  `${base}/${project.name}/`,
    branch:    aap.branch,
    aap_name:  aap.name || aap.id,
    aap_id:    aap.id,
  };
}

// —— Route handlers (called from index.js) ——

export async function handleState(req, res, ctx) {
  _ctx = ctx;
  const raw    = req.query.token || '';
  const parsed = resolveToken(raw);
  if (!parsed) return res.status(400).json({ ok:false, error:'invalid_token' });

  const { tier, token } = parsed;
  const sap = readSAP();

  try {
    if (tier === 'sap') {
      if (token !== sap) return res.status(403).json({ ok:false, error:'forbidden' });
      return res.json({ ok:true, ...buildSAPData() });
    }
    if (tier === 'pap') {
      const p = ctx.modules.drafts.findProjectByPAP(token);
      if (!p) return res.status(404).json({ ok:false, error:'not_found' });
      const versions = await listVersions(p.name).catch(() => []);
      return res.json({ ok:true, ...buildPAPData(p, versions) });
    }
    if (tier === 'aap') {
      const hit = ctx.modules.drafts.findProjectAndAAPByAAPToken(token);
      if (!hit) return res.status(404).json({ ok:false, error:'not_found' });
      return res.json({ ok:true, ...buildAAPData(hit.project, hit.aap) });
    }
  } catch(e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
  return res.status(400).json({ ok:false, error:'unknown_tier' });
}

export function handleWebApp(req, res, ctx) {
  _ctx = ctx;
  const token = req.query.token || '';
  const base  = ctx.config.publicBase;
  res.type('html').send(renderShell(token, base));
}

export async function handleWebhookEnable(req, res, ctx) {
  _ctx = ctx;
  const papToken = parseBearer(req);
  if (!papToken) return res.status(401).json({ ok:false, error:'unauthorized' });
  const p = ctx.modules.drafts.findProjectByPAP(papToken);
  if (!p) return res.status(404).json({ ok:false, error:'not_found' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok:false, error:'url_required' });
  try {
    // Set webhook with Telegram
    const botToken = p.bot?.token;
    if (!botToken) return res.status(400).json({ ok:false, error:'no_bot' });
    const r = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ url }),
    });
    const tgRes = await r.json();
    if (!tgRes.ok) return res.status(400).json({ ok:false, error:'telegram_error', detail:tgRes.description });
    // Save to state
    const state = ctx.modules.drafts.getState();
    const proj  = state.projects.find(x => x.name === p.name);
    if (proj && proj.bot) { proj.bot.webhook_url = url; ctx.modules.drafts.saveState(state); }
    return res.json({ ok:true, webhook_url:url });
  } catch(e) { return res.status(500).json({ ok:false, error:e.message }); }
}

export async function handleWebhookDisable(req, res, ctx) {
  _ctx = ctx;
  const papToken = parseBearer(req);
  if (!papToken) return res.status(401).json({ ok:false, error:'unauthorized' });
  const p = ctx.modules.drafts.findProjectByPAP(papToken);
  if (!p) return res.status(404).json({ ok:false, error:'not_found' });
  try {
    const botToken = p.bot?.token;
    if (!botToken) return res.status(400).json({ ok:false, error:'no_bot' });
    await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, { method:'POST' });
    const state = ctx.modules.drafts.getState();
    const proj  = state.projects.find(x => x.name === p.name);
    if (proj && proj.bot) { proj.bot.webhook_url = null; ctx.modules.drafts.saveState(state); }
    return res.json({ ok:true });
  } catch(e) { return res.status(500).json({ ok:false, error:e.message }); }
}

export async function handleAnalytics(req, res, ctx) {
  _ctx = ctx;
  const papToken = parseBearer(req);
  if (!papToken) return res.status(401).json({ ok:false, error:'unauthorized' });
  const p = ctx.modules.drafts.findProjectByPAP(papToken);
  if (!p) return res.status(404).json({ ok:false, error:'not_found' });
  try {
    const summary = ctx.modules.analytics?.getProjectSummary?.(p.name) || null;
    return res.json({ ok:true, project:p.name, summary });
  } catch(e) { return res.status(500).json({ ok:false, error:e.message }); }
}

// ——————————————————————————————————————————————————————————————
// HTML Mini App shell
// ——————————————————————————————————————————————————————————————

function renderShell(token, base) {
  const stateUrl = `${base}/hub/state?token=${encodeURIComponent(token)}`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Hub</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{
--bg:#000;--card:#0d0d0d;--card-hi:#141414;
--border:rgba(255,255,255,.07);--border-hi:rgba(255,255,255,.16);
--text:#f0f0f0;--muted:#666;--faint:#282828;
--green:#4ade80;--red:#f87171;--blue:#60a5fa;
--r:10px;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{
background:var(--bg);color:var(--text);
font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;
font-size:15px;line-height:1.6;
-webkit-font-smoothing:antialiased;
padding-bottom:max(32px,env(safe-area-inset-bottom));
}
a{color:inherit;text-decoration:none}
#root{padding:24px 16px 48px;max-width:600px;margin:0 auto}
.ey{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-bottom:18px}
h1{font-size:26px;font-weight:800;letter-spacing:-.03em;line-height:1.08;margin-bottom:6px}
.lead{font-size:13px;color:var(--muted);margin-bottom:22px}
.div{border-top:1px solid var(--border);margin:18px 0}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:12px}
.card h3{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);
display:flex;align-items:center;gap:6px;margin-bottom:12px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--faint);flex-shrink:0}
.dot.on{background:var(--green)}
.row{display:flex;justify-content:space-between;align-items:flex-start;
padding:7px 0;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:none}
.rk{font-size:13px;color:var(--muted);flex-shrink:0}
.rv{font-size:12px;font-family:ui-monospace,monospace;text-align:right;word-break:break-all;max-width:58%;color:var(--text)}
.acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.btn{display:inline-flex;align-items:center;justify-content:center;
font-size:13px;font-weight:600;padding:8px 15px;border-radius:8px;
border:1px solid var(--border);background:transparent;color:var(--text);
cursor:pointer;white-space:nowrap;text-decoration:none;-webkit-appearance:none}
.btn:active{opacity:.7}
.btn-p{background:var(--text);color:#000;border-color:var(--text)}
.btn-p:active{background:#bbb}
.btn-d{color:var(--red);border-color:rgba(248,113,113,.22)}
.btn-sm{font-size:11px;padding:4px 9px;border-radius:6px}
.tag{font-size:10px;letter-spacing:.06em;text-transform:uppercase;
padding:2px 6px;border-radius:4px;border:1px solid;white-space:nowrap}
.tg{background:rgba(74,222,128,.1);color:var(--green);border-color:rgba(74,222,128,.2)}
.ty{background:rgba(255,255,255,.04);color:var(--muted);border-color:var(--border)}
.tb{background:rgba(96,165,250,.1);color:var(--blue);border-color:rgba(96,165,250,.2)}
input{width:100%;background:var(--card-hi);border:1px solid var(--border);
border-radius:8px;padding:9px 12px;font-size:13px;color:var(--text);
margin:8px 0;outline:none;-webkit-appearance:none}
input:focus{border-color:var(--border-hi)}
.proj-row{display:flex;align-items:center;justify-content:space-between;
padding:11px 0;border-bottom:1px solid var(--border);cursor:pointer}
.proj-row:last-child{border-bottom:none}
.proj-row:active{opacity:.6}
.pn{font-size:15px;font-weight:600}
.ps{font-size:11px;color:var(--muted);margin-top:1px}
.back{display:inline-flex;align-items:center;gap:5px;font-size:13px;
color:var(--muted);cursor:pointer;margin-bottom:18px}
.agrid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
.abox{background:var(--card-hi);border-radius:8px;padding:10px 12px}
.anum{font-size:22px;font-weight:800;letter-spacing:-.03em}
.albl{font-size:11px;color:var(--muted);margin-top:1px}
.empty{text-align:center;padding:28px;color:var(--faint);font-size:13px}
.logtbl{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}
.logtbl td{padding:3px 5px;border-bottom:1px solid var(--faint);vertical-align:middle}
.logt{color:var(--muted);white-space:nowrap}
.logs.ok{color:var(--green)}
.logs.err{color:var(--red)}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
background:#f0f0f0;color:#000;padding:7px 18px;border-radius:20px;
font-size:12px;font-weight:600;pointer-events:none;opacity:0;
transition:opacity .2s;z-index:9999;white-space:nowrap}
.toast.show{opacity:1}
</style>
</head><body>
<div id="root"><div class="empty">loading…</div></div>
<div class="toast" id="_toast"></div>
<script>
(function(){
'use strict';
const BASE      = ${JSON.stringify(base)};
const STATE_URL = ${JSON.stringify(stateUrl)};
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }
const root     = document.getElementById('root');
const toastEl  = document.getElementById('_toast');
let _toastT, _state, _sapStack = false;

function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.style.background = isErr ? '#f87171' : '#f0f0f0';
  toastEl.classList.add('show');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => toastEl.classList.remove('show'), 2200);
}
function esc(s) {
  return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
}
async function api(method, url, body) {
  const opts = { method, headers: {'Content-Type':'application/json'} };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}
function ago(iso) {
  if (!iso) return '';
  const d = Date.now() - new Date(iso);
  if (d < 60e3)   return Math.floor(d/1e3)+'s';
  if (d < 3600e3) return Math.floor(d/60e3)+'m';
  if (d < 86400e3)return Math.floor(d/3600e3)+'h';
  return Math.floor(d/86400e3)+'d';
}

async function load() {
  try {
    _state = await api('GET', STATE_URL);
    if (!_state.ok) { root.innerHTML = '<div class="empty">'+esc(_state.error||'error')+'</div>'; return; }
    if (_state.tier === 'sap')     renderSAP(_state);
    else if (_state.tier === 'pap') renderPAP(_state);
    else if (_state.tier === 'aap') renderAAP(_state);
    else root.innerHTML = '<div class="empty">unknown tier</div>';
  } catch(e) {
    root.innerHTML = '<div class="empty">failed: '+esc(e.message)+'</div>';
  }
}

// — SAP —
function renderSAP(d) {
  let h = '';
  h += '<div class="ey">HUB · SERVER ROOT · SAP</div>';
  h += '<h1>Dashboard.</h1>';
  h += '<p class="lead">'+(d.projects.length)+' project'+(d.projects.length!==1?'s':'')+' · up '+Math.floor(d.uptime_sec/60)+'m</p>';
  if (!d.projects.length) {
    h += '<div class="empty">No projects yet.<br>Send /new name in the bot.</div>';
  } else {
    h += '<div class="card"><h3><span class="dot on"></span>Projects</h3>';
    for (const p of d.projects) {
      const botTag = p.bot ? ' · @'+esc(p.bot.username) : '';
      h += '<div class="proj-row" data-state="'+esc(p.state_pap_url||'')+'">';
      h += '<div><div class="pn">'+esc(p.description)+'</div>';
      h += '<div class="ps">'+esc(p.name)+botTag+'</div></div>';
      h += '<span class="tag '+(p.bot?'tg':'ty')+'">'+(p.bot?p.bot.mode:'no bot')+'</span>';
      h += '</div>';
    }
    h += '</div>';
  }
  h += '<div class="div"></div>';
  h += '<div class="card"><h3><span class="dot"></span>Create project</h3>';
  h += '<input id="_nn" placeholder="project-name" autocomplete="off" autocorrect="off" spellcheck="false"/>';
  h += '<input id="_nd" placeholder="Description (optional)"/>';
  h += '<div class="acts"><button class="btn btn-p" id="_ncb">Create</button></div></div>';
  root.innerHTML = h;

  root.querySelectorAll('.proj-row').forEach(el => {
    el.addEventListener('click', async () => {
      const stateUrl = el.getAttribute('data-state');
      if (!stateUrl) return;
      try {
        _sapStack = true;
        const r = await api('GET', stateUrl);
        if (r.ok) renderPAP(r);
        else toast(r.error||'failed','err');
      } catch(e) { toast(e.message,'err'); }
    });
  });
  document.getElementById('_ncb').addEventListener('click', async () => {
    const name = document.getElementById('_nn').value.trim().toLowerCase().replace(/[^a-z0-9_-]/g,'');
    const desc = document.getElementById('_nd').value.trim();
    if (!name) { toast('name required','err'); return; }
    try {
      const r = await api('POST', BASE+'/drafts/projects', { name, description: desc||undefined });
      if (r.ok) { toast('created ✓'); setTimeout(load,700); }
      else toast((r.error||'failed'),'err');
    } catch(e) { toast(e.message,'err'); }
  });
}

// — PAP —
function renderPAP(d) {
  const PAP = d.pap_token || '';
  let h = '';
  if (_sapStack) h += '<div class="back" id="_bk">← back</div>';
  h += '<div class="ey">HUB · '+esc(d.name)+' · PAP</div>';
  h += '<h1>'+esc(d.description)+'</h1>';
  h += '<p class="lead"><a href="'+esc(d.live_url)+'" target="_blank">'+esc(d.live_url)+'</a>';
  if (d.versions.length) h += ' · v'+esc(String(d.versions[d.versions.length-1]));
  h += ' · '+(d.aaps.length)+' contributor'+(d.aaps.length!==1?'s':'')+'</p>';

  // Bot card
  h += '<div class="card">';
  if (d.bot) {
    h += '<h3><span class="dot on"></span>Bot &nbsp;<span class="tag tg">'+esc(d.bot.mode)+'</span></h3>';
    h += '<div class="row"><span class="rk">@username</span><span class="rv">@'+esc(d.bot.username)+'</span></div>';
    h += '<div class="row"><span class="rk">subscribers</span><span class="rv">'+d.bot.subscribers+'</span></div>';
    h += '<div class="acts">';
    h += '<a href="https://t.me/'+esc(d.bot.username)+'" target="_blank" class="btn btn-p">Open in Telegram</a>';
    h += '<button class="btn btn-d" id="_ub">Unlink</button></div>';
  } else {
    h += '<h3><span class="dot"></span>Bot</h3>';
    h += '<div class="empty" style="padding:8px 0 4px">No bot linked.</div>';
    h += '<input id="_bt" placeholder="Paste token from @BotFather" autocorrect="off"/>';
    h += '<div class="acts"><button class="btn btn-p" id="_lb">Link bot</button></div>';
  }
  h += '</div>';

  // Webhook card
  if (d.bot) {
    h += '<div class="card">';
    if (d.bot.mode === 'webhook') {
      h += '<h3><span class="dot on"></span>Webhook</h3>';
      h += '<div class="row"><span class="rk">URL</span><span class="rv">'+esc(d.bot.webhook_url)+'</span></div>';
      if (d.bot.webhook_log.length) {
        h += '<table class="logtbl">';
        for (const e of d.bot.webhook_log) {
          const ok = e.status >= 200 && e.status < 300;
          h += '<tr><td class="logt">'+ago(e.at)+'</td>';
          h += '<td class="logs '+(ok?'ok':'err')+'">'+(e.status||e.error)+'</td>';
          h += '<td>'+Math.round(e.latency_ms||0)+'ms</td></tr>';
        }
        h += '</table>';
      } else {
        h += '<div style="font-size:12px;color:#444;margin-top:6px">no calls yet — when Telegram sends an update it\'ll show here.</div>';
      }
      h += '<div class="acts"><button class="btn btn-d" id="_dwh">Switch to polling</button></div>';
    } else {
      h += '<h3><span class="dot"></span>Webhook</h3>';
      h += '<div style="font-size:12px;color:#444;margin-bottom:6px">Using long polling. Webhook mode forwards every Telegram update to your URL.</div>';
      h += '<input type="url" id="_wi" placeholder="https://your-app.vercel.app/webhook"/>';
      h += '<div class="acts"><button class="btn btn-p" id="_ewh">Enable webhook</button></div>';
    }
    h += '</div>';
  }

  // Analytics card
  h += '<div class="card" id="_ac">';
  if (d.bot) {
    if (d.analytics) {
      h += analyticsHtml(d.analytics);
    } else {
      h += '<h3><span class="dot"></span>Analytics</h3><div class="empty" style="padding:8px 0">loading…</div>';
    }
  } else {
    h += '<h3><span class="dot"></span>Analytics</h3><div class="empty" style="padding:8px 0">Link a bot to see analytics.</div>';
  }
  h += '</div>';

  // Versions
  if (d.versions.length) {
    h += '<div class="card"><h3><span class="dot"></span>Versions</h3>';
    for (const v of [...d.versions].reverse().slice(0,6)) {
      const live = v === d.versions[d.versions.length-1];
      h += '<div class="row"><span class="rk">v'+v+'</span><span class="rv">';
      h += live ? '<span class="tag tg">live</span>' : '<a href="'+esc(d.live_url)+'v/'+v+'/" target="_blank" class="btn btn-sm">view</a>';
      h += '</span></div>';
    }
    h += '<div class="acts"><button class="btn btn-p" id="_pr">Promote draft → live</button></div></div>';
  }

  // Build
  h += '<div class="card"><h3><span class="dot"></span>Build loop</h3>';
  h += '<div class="row"><span class="rk">upload</span><span class="rv">POST /drafts/upload</span></div>';
  h += '<div class="row"><span class="rk">commit</span><span class="rv">POST /drafts/commit</span></div>';
  h += '<div class="row"><span class="rk">promote</span><span class="rv">POST /drafts/promote</span></div>';
  h += '<div class="acts"><a href="'+esc(d.live_url)+'" class="btn btn-p" target="_blank">Open live</a></div></div>';

  // Contributors
  if (d.aaps.length) {
    h += '<div class="card"><h3><span class="dot"></span>Contributors ('+d.aaps.length+')</h3>';
    for (const a of d.aaps)
      h += '<div class="row"><span class="rk">'+esc(a.name)+'</span><span class="rv"><a href="'+esc(a.webapp_url)+'" class="btn btn-sm" target="_blank">open</a></span></div>';
    h += '</div>';
  }

  // This link
  h += '<div class="card"><h3><span class="dot"></span>This link (PAP)</h3>';
  h += '<div style="font-size:11px;font-family:ui-monospace,monospace;color:#555;word-break:break-all;margin-bottom:10px">'+esc(d.pap_url||d.webapp_url||'')+'</div>';
  h += '<div class="acts"><button class="btn" id="_cp">Copy link</button></div></div>';

  root.innerHTML = h;

  // Back
  document.getElementById('_bk')?.addEventListener('click', () => { _sapStack=false; renderSAP(_state); });

  // Bot
  document.getElementById('_lb')?.addEventListener('click', async () => {
    const tok = document.getElementById('_bt').value.trim();
    if (!tok) { toast('paste token first','err'); return; }
    try {
      const r = await fetch(BASE+'/drafts/project/bot', { method:'PUT',
        headers:{'Authorization':'Bearer '+PAP,'Content-Type':'application/json'},
        body:JSON.stringify({token:tok}) });
      const j = await r.json();
      if (j.ok) { toast('linked: @'+j.bot.bot_username); setTimeout(load,700); }
      else toast(j.detail||j.error||'failed','err');
    } catch(e) { toast(e.message,'err'); }
  });
  document.getElementById('_ub')?.addEventListener('click', async () => {
    if (!confirm('Unlink bot?')) return;
    try {
      const r = await fetch(BASE+'/drafts/project/bot', { method:'DELETE',
        headers:{'Authorization':'Bearer '+PAP} });
      const j = await r.json();
      if (j.ok) { toast('unlinked'); setTimeout(load,600); }
      else toast(j.error||'failed','err');
    } catch(e) { toast(e.message,'err'); }
  });

  // Webhook
  document.getElementById('_ewh')?.addEventListener('click', async () => {
    const url = document.getElementById('_wi').value.trim();
    if (!url) { toast('paste webhook URL first','err'); return; }
    try {
      const r = await fetch(BASE+'/drafts/project/webhook', { method:'PUT',
        headers:{'Authorization':'Bearer '+PAP,'Content-Type':'application/json'},
        body:JSON.stringify({url}) });
      const j = await r.json();
      if (j.ok) { toast('webhook enabled'); setTimeout(load,600); }
      else toast(j.error||'failed','err');
    } catch(e) { toast(e.message,'err'); }
  });
  document.getElementById('_dwh')?.addEventListener('click', async () => {
    if (!confirm('Switch to polling?')) return;
    try {
      const r = await fetch(BASE+'/drafts/project/webhook', { method:'DELETE',
        headers:{'Authorization':'Bearer '+PAP} });
      const j = await r.json();
      if (j.ok) { toast('switched to polling'); setTimeout(load,600); }
      else toast(j.error||'failed','err');
    } catch(e) { toast(e.message,'err'); }
  });

  // Promote
  document.getElementById('_pr')?.addEventListener('click', async () => {
    try {
      const r = await fetch(BASE+'/drafts/promote', { method:'POST',
        headers:{'Authorization':'Bearer '+PAP,'Content-Type':'application/json'} });
      const j = await r.json();
      if (j.ok) { toast('promoted ✓'); setTimeout(load,600); }
      else toast(j.detail||j.error||'failed','err');
    } catch(e) { toast(e.message,'err'); }
  });

  // Copy
  document.getElementById('_cp')?.addEventListener('click', () => {
    const url = d.pap_url || d.webapp_url || '';
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('copied ✓'));
    else toast(url);
  });

  // Load analytics async if not already present
  if (d.bot && !d.analytics) {
    fetch(BASE+'/drafts/project/analytics', {
      headers:{'Authorization':'Bearer '+PAP}
    }).then(r => r.json()).then(r => {
      const card = document.getElementById('_ac');
      if (!card) return;
      if (!r.ok || !r.summary) { card.innerHTML = '<h3><span class="dot"></span>Analytics</h3><div style="font-size:12px;color:#444;padding:8px 0">no data yet</div>'; return; }
      card.innerHTML = analyticsHtml(r.summary);
    }).catch(() => {});
  }
}

function analyticsHtml(s) {
  if (!s) return '<h3><span class="dot"></span>Analytics</h3><div class="empty" style="padding:8px 0">no data</div>';
  let h = '<h3><span class="dot on"></span>Analytics</h3>';
  h += '<div class="agrid">';
  h += '<div class="abox"><div class="anum">'+(s.total_users||0)+'</div><div class="albl">users</div></div>';
  h += '<div class="abox"><div class="anum">'+(s.total_messages||0)+'</div><div class="albl">messages</div></div>';
  h += '</div>';
  if (s.top_languages && s.top_languages.length) {
    h += '<div style="margin-top:10px;font-size:11px;color:#555">';
    h += s.top_languages.slice(0,5).map(l => esc(l.lang||'?')+' '+l.count).join(' · ');
    h += '</div>';
  }
  return h;
}

// — AAP —
function renderAAP(d) {
  let h = '';
  h += '<div class="ey">HUB · '+esc(d.project_name)+' · CONTRIBUTOR</div>';
  h += '<h1>'+esc(d.aap_name)+'</h1>';
  h += '<p class="lead">Contributing to <a href="'+esc(d.live_url)+'" target="_blank">'+esc(d.project_name)+'</a></p>';
  h += '<div class="card"><h3><span class="dot"></span>Branch</h3>';
  h += '<div class="row"><span class="rk">branch</span><span class="rv">'+esc(d.branch)+'</span></div></div>';
  h += '<div class="card"><h3><span class="dot"></span>Build loop</h3>';
  h += '<div class="row"><span class="rk">upload</span><span class="rv">POST /drafts/upload</span></div>';
  h += '<div class="row"><span class="rk">commit</span><span class="rv">POST /drafts/commit</span></div>';
  h += '</div>';
  root.innerHTML = h;
}

load();
})();
</script>
</body></html>`;
}
