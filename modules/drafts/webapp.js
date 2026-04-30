// modules/drafts/webapp.js — Telegram Mini App dashboard
// Iteration 2: Full Bot section — broadcast, bot sync, webhook, analytics stub

import fs   from 'fs';
import path from 'path';

let _ctx;

function readSAP() {
  try { return fs.readFileSync('/etc/hub/sap.token', 'utf8').trim(); } catch { return ''; }
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function parseToken(req) {
  const fromQuery  = req.query?.token || '';
  const fromHeader = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const raw = fromQuery || fromHeader;
  const sap = readSAP();

  const newFmt = raw.match(/^pass_(\d+)_([a-z][a-z0-9]*)_(.+)$/);
  if (newFmt) {
    const role = newFmt[2], hex = newFmt[3];
    if (role === 'server')  return { tier: 'sap', token: hex };
    if (role === 'project') return { tier: 'pap', token: 'pap_' + hex };
    if (role === 'agent')   return { tier: 'aap', token: 'aap_' + hex };
  }
  if (raw.startsWith('pap_')) return { tier: 'pap', token: raw };
  if (raw.startsWith('aap_')) return { tier: 'aap', token: raw };
  if (/^[0-9a-f]{12,64}$/i.test(raw) && raw === sap) return { tier: 'sap', token: raw };
  return null;
}

// ─── State builders ────────────────────────────────────────────────────────────

function buildSAPState() {
  const st   = _ctx.modules.drafts.getState();
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  return {
    tier: 'sap',
    server: { base, server_number: sn, uptime_sec: Math.floor(process.uptime()) },
    projects: st.projects.map(p => ({
      name:             p.name,
      description:      p.description || p.name,
      live_url:         base + '/' + p.name + '/',
      pap_url:          p.pap?.token ? base+'/signin/pass_'+sn+'_project_'+p.pap.token.replace(/^pap_/,'') : null,
      pap_token:        p.pap?.token || null,
      has_bot:          !!(p.bot?.token),
      bot_username:     p.bot?.bot_username || null,
      bot_mode:         p.bot?.webhook_url ? 'webhook' : 'polling',
      subscriber_count: (p.bot?.subscribers || []).length,
      aap_count:        (p.aaps || []).filter(a => !a.revoked).length,
    })),
  };
}

function buildPAPState(project) {
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  const papSecret = project.pap?.token?.replace(/^pap_/, '');
  const subs = project.bot?.subscribers || [];

  // Aggregate language stats
  const langMap = {};
  subs.forEach(s => {
    const l = s.language_code || 'unknown';
    langMap[l] = (langMap[l] || 0) + 1;
  });
  const langs = Object.entries(langMap).sort((a,b) => b[1]-a[1]).slice(0, 8);

  return {
    tier:        'pap',
    name:        project.name,
    description: project.description || project.name,
    live_url:    base + '/' + project.name + '/',
    pap_url:     papSecret ? base+'/signin/pass_'+sn+'_project_'+papSecret : null,
    pap_token:   project.pap?.token || null,

    bot: project.bot ? {
      username:          project.bot.bot_username,
      bot_id:            project.bot.bot_id,
      mode:              project.bot.webhook_url ? 'webhook' : 'polling',
      webhook_url:       project.bot.webhook_url || null,
      webhook_log:       (project.bot.webhook_log || []).slice(0, 10),
      subscribers:       subs.length,
      analytics_enabled: project.bot.analytics_enabled ?? true,
      langs,
    } : null,

    github: {
      repo:     project.github_repo || null,
      autosync: project.github_autosync || false,
    },

    aaps: (project.aaps || []).filter(a => !a.revoked).map(a => ({
      id:   a.id,
      name: a.name || a.id,
      url:  base+'/signin/pass_'+sn+'_agent_'+a.token.replace(/^aap_/, ''),
    })),

    api_base: base + '/drafts',
  };
}

function buildAAPState(project, aap) {
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  return {
    tier:      'aap',
    name:      project.name,
    aap_name:  aap.name || aap.id,
    branch:    aap.branch,
    live_url:  base + '/' + project.name + '/',
    aap_url:   base+'/signin/pass_'+sn+'_agent_'+aap.token.replace(/^aap_/, ''),
    api_base:  base + '/drafts',
    aap_token: aap.token,
  };
}

// ─── HTML shell ────────────────────────────────────────────────────────────────

function renderShell() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Hub</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--tg-theme-bg-color,#0f0f0f);color:var(--tg-theme-text-color,#f0f0f0);font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--tg-theme-link-color,#60a5fa);text-decoration:none}
#root{padding:16px 16px 72px}
.ey{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#555;margin-bottom:18px}
h1{font-size:24px;font-weight:800;letter-spacing:-.03em;line-height:1.1;margin-bottom:4px}
.lead{font-size:13px;color:#555;margin-bottom:20px}
.divider{border:none;border-top:1px solid rgba(255,255,255,.07);margin:18px 0}
.sec{margin-bottom:4px}
.sec-title{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#444;margin-bottom:10px;font-weight:600}
.card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px;margin-bottom:10px}
.card-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:14px;font-weight:700}
.dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex-shrink:0}
.dot.off{background:#444}
.tag{font-size:10px;letter-spacing:.07em;text-transform:uppercase;padding:2px 7px;border-radius:4px;background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.2)}
.tag.off{background:rgba(255,255,255,.04);color:#444;border-color:rgba(255,255,255,.07)}
.tag.blue{background:rgba(96,165,250,.1);color:#60a5fa;border-color:rgba(96,165,250,.2)}
.row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.row:last-child{border-bottom:none}
.rk{font-size:12px;color:#555;flex-shrink:0;width:88px}
.rv{font-size:12px;color:#aaa;word-break:break-all;flex:1}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.btn{font-size:13px;font-weight:600;padding:8px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#aaa;cursor:pointer;white-space:nowrap;text-align:center}
.btn:active{opacity:.6}
.btn-prim{background:#fff;color:#000;border-color:#fff}
.btn-prim:active{background:#ddd}
.btn-full{width:100%;display:block;padding:11px}
.btn-ghost{border-color:rgba(255,255,255,.12);color:#888}
.btn-blue{border-color:rgba(96,165,250,.3);color:#60a5fa}
.btn-danger{border-color:rgba(248,113,113,.3);color:#f87171}
input[type=text],input[type=url],textarea{width:100%;background:#111;border:1px solid rgba(255,255,255,.1);color:#f0f0f0;padding:9px 12px;border-radius:8px;font-size:13px;margin-bottom:8px;font-family:inherit;resize:vertical}
input:focus,textarea:focus{outline:none;border-color:rgba(255,255,255,.25)}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0}
.toggle{width:44px;height:24px;border-radius:12px;background:#333;position:relative;cursor:pointer;flex-shrink:0;border:none;outline:none;transition:background .15s}
.toggle.on{background:#4ade80}
.toggle::after{content:'';position:absolute;width:18px;height:18px;border-radius:9px;background:#fff;top:3px;left:3px;transition:left .15s}
.toggle.on::after{left:23px}
.log-tbl{width:100%;font-size:11px;border-collapse:collapse;margin-top:6px}
.log-tbl td{padding:4px 5px;border-bottom:1px solid rgba(255,255,255,.04)}
.s-ok{color:#4ade80}.s-err{color:#f87171}.s-time{color:#444}
.proj-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer}
.proj-row:last-child{border-bottom:none}
.proj-row:active{opacity:.6}
.proj-name{font-size:14px;font-weight:700}
.proj-meta{font-size:12px;color:#555;margin-top:1px}
.chevron{color:#333;font-size:18px}
.empty{text-align:center;padding:40px 16px;color:#333;font-size:14px}
.muted{font-size:12px;color:#555;line-height:1.5}
.lang-bar{margin-top:10px}
.lang-row{display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:12px}
.lang-label{color:#666;width:52px;flex-shrink:0}
.lang-track{flex:1;height:6px;background:rgba(255,255,255,.07);border-radius:3px;overflow:hidden}
.lang-fill{height:100%;background:#4ade80;border-radius:3px}
.lang-n{color:#555;width:28px;text-align:right;flex-shrink:0}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.stat-box{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:10px 12px;text-align:center}
.stat-n{font-size:22px;font-weight:800;letter-spacing:-.02em}
.stat-l{font-size:10px;color:#444;letter-spacing:.06em;text-transform:uppercase;margin-top:2px}
.broadcast-area{margin-top:10px}
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.9);border:1px solid rgba(255,255,255,.15);color:#f0f0f0;padding:8px 18px;border-radius:20px;font-size:13px;z-index:999;pointer-events:none;opacity:0;transition:opacity .18s;white-space:nowrap}
.toast.show{opacity:1}
footer{position:fixed;bottom:0;left:0;right:0;height:50px;background:var(--tg-theme-bg-color,#0f0f0f);border-top:1px solid rgba(255,255,255,.06);display:flex;align-items:center;justify-content:center;font-size:10px;color:#2a2a2a;font-family:ui-monospace,monospace;letter-spacing:.05em}
.back-btn{display:none;position:fixed;top:env(safe-area-inset-top,0);left:0;right:0;height:42px;background:var(--tg-theme-bg-color,#0f0f0f);border-bottom:1px solid rgba(255,255,255,.07);align-items:center;padding:0 14px;gap:8px;font-size:14px;cursor:pointer;z-index:100}
.back-btn.show{display:flex}
.back-top{padding-top:50px}
</style>
</head>
<body>
<div id="back-nav" class="back-btn"><span style="font-size:20px">&#8249;</span><span id="back-label">back</span></div>
<div id="root"><div class="empty">loading&hellip;</div></div>
<footer>hub &middot; hub.labs.co</footer>
<div id="toast" class="toast"></div>
<script>
(function(){
'use strict';
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const ROOT  = document.getElementById('root');
const BACK  = document.getElementById('back-nav');
const TOAST = document.getElementById('toast');
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const BASE  = location.origin;
let STATE = null;
let SAP_STATE = null;  // kept for back-nav

function esc(s) {
  if(s==null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg, type) {
  TOAST.textContent = msg;
  TOAST.className = 'toast show';
  clearTimeout(TOAST._t);
  TOAST._t = setTimeout(() => TOAST.className='toast', 2600);
}

function timeAgo(iso) {
  const d = Date.now() - new Date(iso);
  if (d < 60000) return Math.floor(d/1000)+'s ago';
  if (d < 3600000) return Math.floor(d/60000)+'m ago';
  return Math.floor(d/3600000)+'h ago';
}

async function api(method, url, body, token) {
  const tok = token || STATE?.pap_token;
  const r = await fetch(url, {
    method,
    headers: { 'Authorization': 'Bearer '+tok, 'Content-Type':'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// ── SAP view ──────────────────────────────────────────────────────────────────

function renderSAP(d) {
  SAP_STATE = d;
  let h = '<div class="ey">HUB &middot; SERVER &middot; SAP</div>';
  h += '<h1>Server dashboard.</h1>';
  const up = Math.floor(d.server.uptime_sec/60);
  h += '<p class="lead">'+d.projects.length+' project'+(d.projects.length!==1?'s':'')+' &middot; up '+up+'m</p>';

  // Stats row
  const withBot = d.projects.filter(p=>p.has_bot);
  const totalSubs = d.projects.reduce((s,p)=>s+p.subscriber_count,0);
  h += '<div class="stat-grid">';
  h += '<div class="stat-box"><div class="stat-n">'+withBot.length+'</div><div class="stat-l">bots</div></div>';
  h += '<div class="stat-box"><div class="stat-n">'+totalSubs+'</div><div class="stat-l">subscribers</div></div>';
  h += '</div><hr class="divider">';

  if (!d.projects.length) {
    h += '<div class="empty">No projects yet.</div>';
  } else {
    h += '<div class="sec"><div class="sec-title">Projects</div>';
    d.projects.forEach(p => {
      h += '<div class="proj-row" data-name="'+esc(p.name)+'" data-pap="'+esc(p.pap_token||'')+'">';
      h += '<div><div class="proj-name">'+esc(p.description)+'</div>';
      h += '<div class="proj-meta">'+esc(p.name)+(p.has_bot?' &middot; @'+esc(p.bot_username)+' &middot; '+p.subscriber_count+' subs':'')+'</div></div>';
      h += '<div style="display:flex;align-items:center;gap:6px">';
      if (p.has_bot) h += '<span class="tag">bot</span>';
      else h += '<span class="tag off">no bot</span>';
      h += '<span class="chevron">&#8250;</span></div></div>';
    });
    h += '</div>';
  }
  ROOT.innerHTML = h;
  BACK.className = 'back-btn';

  document.querySelectorAll('.proj-row').forEach(btn => {
    btn.addEventListener('click', async () => {
      const papToken = btn.getAttribute('data-pap');
      if (!papToken) { toast('no PAP token','err'); return; }
      showBack(btn.getAttribute('data-name'));
      try {
        const r = await fetch(BASE+'/hub/api/state?token='+encodeURIComponent(papToken));
        const pd = await r.json();
        if (pd.tier==='pap') renderPAP(pd);
        else toast('failed','err');
      } catch(e) { hideBack(); toast('error: '+e.message,'err'); }
    });
  });
}

// ── PAP view ──────────────────────────────────────────────────────────────────

function renderPAP(d) {
  STATE = d;
  let h = '<div class="back-top"><div class="ey">HUB &middot; '+esc(d.name.toUpperCase())+' &middot; PAP</div>';
  h += '<h1>'+esc(d.description)+'</h1>';
  h += '<p class="lead"><a href="'+esc(d.live_url)+'" target="_blank">'+esc(d.live_url)+'</a></p>';

  // ── 1. BOT section
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Bot</div>';
  if (d.bot) {
    h += '<div class="card">';
    h += '<div class="card-head"><span class="dot"></span>@'+esc(d.bot.username)+'<span class="tag">'+esc(d.bot.mode)+'</span></div>';

    // Stats row
    h += '<div class="stat-grid" style="margin-bottom:10px">';
    h += '<div class="stat-box"><div class="stat-n">'+d.bot.subscribers+'</div><div class="stat-l">subscribers</div></div>';
    h += '<div class="stat-box"><div class="stat-n">'+(d.bot.analytics_enabled?'on':'off')+'</div><div class="stat-l">analytics</div></div>';
    h += '</div>';

    // Webhook status
    if (d.bot.mode === 'webhook') {
      h += '<div class="row"><span class="rk">webhook</span><span class="rv" style="font-size:11px">'+esc(d.bot.webhook_url)+'</span></div>';
      if (d.bot.webhook_log?.length) {
        h += '<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#444;margin:10px 0 3px">Recent calls</div>';
        h += '<table class="log-tbl">';
        d.bot.webhook_log.forEach(e => {
          const ok = e.status>=200 && e.status<300;
          const t  = e.status>0 ? String(e.status) : (e.error||'err');
          h += '<tr><td class="s-time">'+timeAgo(e.at)+'</td><td class="s-'+(ok?'ok':'err')+'">'+esc(t)+'</td><td style="color:#444">'+( e.latency_ms||'')+'ms</td></tr>';
        });
        h += '</table>';
      }
    }

    // Language breakdown
    if (d.bot.langs?.length) {
      const total = d.bot.langs.reduce((s,[,n])=>s+n,0)||1;
      h += '<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#444;margin:10px 0 3px">Audience languages</div>';
      h += '<div class="lang-bar">';
      d.bot.langs.forEach(([l,n]) => {
        const pct = Math.round((n/total)*100);
        h += '<div class="lang-row"><span class="lang-label">'+esc(l)+'</span>';
        h += '<div class="lang-track"><div class="lang-fill" style="width:'+pct+'%"></div></div>';
        h += '<span class="lang-n">'+n+'</span></div>';
      });
      h += '</div>';
    }

    // Webhook input (polling mode)
    if (d.bot.mode === 'polling') {
      h += '<div style="margin-top:10px"><input type="url" id="webhookInput" placeholder="https://your-app.vercel.app/webhook"></div>';
    }

    // Bot actions
    h += '<div class="actions">';
    if (d.bot.mode === 'polling') h += '<button class="btn btn-ghost" id="webhookModeBtn">&#8645; enable webhook</button>';
    else h += '<button class="btn btn-ghost" id="webhookModeBtn">&#8645; switch to polling</button>';
    h += '<button class="btn btn-blue" id="syncBotBtn">&#8635; sync bot</button>';
    h += '<button class="btn btn-danger" id="unlinkBotBtn">unlink</button>';
    h += '</div></div>';

    // Broadcast card
    h += '<div class="card">';
    h += '<div class="card-head"><span class="tag blue">broadcast</span></div>';
    h += '<div class="muted" style="margin-bottom:8px">Send a message to all '+d.bot.subscribers+' subscriber'+(d.bot.subscribers!==1?'s':'')+'.</div>';
    h += '<div class="broadcast-area"><textarea id="broadcastMsg" rows="3" placeholder="What\'s new? (leave empty to just sync bot profile)"></textarea></div>';
    h += '<div class="actions"><button class="btn btn-prim btn-full" id="broadcastBtn">&#8801; send broadcast</button></div>';
    h += '</div>';

  } else {
    // No bot linked
    h += '<div class="card">';
    h += '<div class="muted" style="margin-bottom:10px">No bot linked. Get a token from @BotFather.</div>';
    h += '<input type="text" id="botTokenInput" placeholder="123456:ABC...">';
    h += '<div class="actions"><button class="btn btn-prim btn-full" id="linkBotBtn">Link bot</button></div>';
    h += '</div>';
  }
  h += '</div>';

  // ── 2. GITHUB section
  h += '<hr class="divider"><div class="sec"><div class="sec-title">GitHub</div><div class="card">';
  h += '<div class="card-head"><span class="dot '+(d.github.repo?'':'off')+'"></span>github</div>';
  if (d.github.repo) {
    h += '<div class="row"><span class="rk">repo</span><span class="rv">'+esc(d.github.repo)+'</span></div>';
    h += '<div class="toggle-row"><div><div style="font-size:13px;font-weight:600">auto-sync</div><div class="muted">push on every commit</div></div>';
    h += '<button class="toggle '+(d.github.autosync?'on':'')+' " id="autosyncToggle"></button></div>';
    h += '<div class="actions">';
    h += '<button class="btn btn-ghost" id="githubSyncBtn">&#8593; push now</button>';
    h += '<button class="btn btn-danger" id="githubUnlinkBtn">unlink</button>';
    h += '</div>';
  } else {
    h += '<input type="text" id="githubRepoInput" placeholder="owner/repo">';
    h += '<div class="actions"><button class="btn btn-full btn-prim" id="githubLinkBtn">&#128279; link repo</button></div>';
  }
  h += '</div></div>';

  // ── 3. CONTRIBUTORS section
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Contributors'+(d.aaps?.length?' ('+d.aaps.length+')':'')+'</div>';
  if (d.aaps?.length) {
    d.aaps.forEach(a => {
      h += '<div class="card"><div class="row"><span class="rk">'+esc(a.name)+'</span>';
      h += '<span class="rv"><a href="'+esc(a.url)+'">dashboard</a></span></div></div>';
    });
  } else {
    h += '<div class="card"><div class="muted">No contributors yet.</div></div>';
  }
  h += '</div>';

  // ── 4. THIS LINK
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Your pass (PAP)</div>';
  h += '<div class="card"><div class="muted" style="margin-bottom:8px">Bookmark this link — it\'s your project dashboard.</div>';
  h += '<div class="actions"><button class="btn btn-ghost" id="copyPAPBtn">&#128203; copy link</button></div></div>';
  h += '</div></div>'; // close back-top

  ROOT.innerHTML = h;

  const apiBase = d.api_base || (location.origin+'/drafts');

  // Link bot
  document.getElementById('linkBotBtn')?.addEventListener('click', async () => {
    const t = document.getElementById('botTokenInput')?.value.trim();
    if (!t) return;
    try {
      const r = await api('PUT', apiBase+'/project/bot', {token:t});
      if (r.ok) { toast('Bot linked: @'+r.bot.bot_username); setTimeout(reloadPAP,600); }
      else toast('Failed: '+(r.detail||r.error),'err');
    } catch(e) { toast('Error: '+e.message,'err'); }
  });

  // Unlink bot
  document.getElementById('unlinkBotBtn')?.addEventListener('click', async () => {
    if (!confirm('Unlink this bot?')) return;
    try {
      const r = await api('DELETE', apiBase+'/project/bot');
      if (r.ok) { toast('Bot unlinked'); setTimeout(reloadPAP,600); }
      else toast('Failed: '+r.error,'err');
    } catch(e) { toast('Error: '+e.message,'err'); }
  });

  // Webhook toggle
  document.getElementById('webhookModeBtn')?.addEventListener('click', async () => {
    if (d.bot.mode === 'polling') {
      const url = document.getElementById('webhookInput')?.value.trim();
      if (!url) { toast('Enter webhook URL first'); return; }
      try {
        const r = await api('PUT', apiBase+'/project/bot/webhook', {url});
        if (r.ok) { toast('Webhook enabled'); setTimeout(reloadPAP,600); }
        else toast('Failed: '+(r.detail||r.error),'err');
      } catch(e) { toast('Error: '+e.message,'err'); }
    } else {
      try {
        const r = await api('DELETE', apiBase+'/project/bot/webhook');
        if (r.ok) { toast('Switched to polling'); setTimeout(reloadPAP,600); }
        else toast('Failed: '+r.error,'err');
      } catch(e) { toast('Error: '+e.message,'err'); }
    }
  });

  // Bot sync
  document.getElementById('syncBotBtn')?.addEventListener('click', async () => {
    try {
      const r = await api('POST', BASE+'/hub/api/bot/sync', {});
      if (r.ok) toast('Bot synced to Telegram');
      else toast('Failed: '+(r.error||r.detail),'err');
    } catch(e) { toast('Error: '+e.message,'err'); }
  });

  // Broadcast
  document.getElementById('broadcastBtn')?.addEventListener('click', async () => {
    const msg = document.getElementById('broadcastMsg')?.value.trim();
    const btn = document.getElementById('broadcastBtn');
    btn.textContent = 'Sending...';
    btn.disabled = true;
    try {
      const r = await api('POST', BASE+'/hub/api/broadcast', {message: msg});
      if (r.ok) {
        const sent = r.sent || 0;
        const skipped = r.skipped || 0;
        toast('Sent to '+sent+' subscriber'+(sent!==1?'s':'')+(skipped?' ('+skipped+' skipped)':''));
        document.getElementById('broadcastMsg').value = '';
      } else toast('Failed: '+(r.error||r.detail),'err');
    } catch(e) { toast('Error: '+e.message,'err'); }
    btn.textContent = '\u2261 send broadcast';
    btn.disabled = false;
  });

  // GitHub autosync
  document.getElementById('autosyncToggle')?.addEventListener('click', async function() {
    const next = !d.github.autosync;
    d.github.autosync = next;
    this.className = 'toggle '+(next?'on':'');
    try {
      await api('PUT', apiBase+'/project/github-autosync', {enabled:next});
      toast(next?'Auto-sync on':'Auto-sync off');
    } catch(e) { toast('Error: '+e.message,'err'); }
  });

  document.getElementById('githubSyncBtn')?.addEventListener('click', async () => {
    try {
      const r = await api('POST', apiBase+'/github/sync', {});
      if (r.ok) toast('Pushed to GitHub');
      else toast('Failed: '+(r.error||r.detail),'err');
    } catch(e) { toast('Error: '+e.message,'err'); }
  });

  document.getElementById('githubLinkBtn')?.addEventListener('click', async () => {
    toast('GitHub link: use web dashboard');
  });

  document.getElementById('githubUnlinkBtn')?.addEventListener('click', async () => {
    toast('GitHub unlink: use web dashboard');
  });

  // Copy PAP link
  document.getElementById('copyPAPBtn')?.addEventListener('click', () => {
    const url = d.pap_url || location.href;
    navigator.clipboard?.writeText(url)
      .then(() => toast('Link copied'))
      .catch(() => toast('Copy: '+url.slice(0,50)+'...'));
  });
}

// ── AAP view ──────────────────────────────────────────────────────────────────

function renderAAP(d) {
  let h = '<div class="ey">HUB &middot; '+esc(d.name.toUpperCase())+' &middot; AAP</div>';
  h += '<h1>'+esc(d.aap_name)+'</h1>';
  h += '<p class="lead">Contributor on <a href="'+esc(d.live_url)+'">'+esc(d.name)+'</a> &middot; branch: <code>'+esc(d.branch)+'</code></p>';
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Build loop</div>';
  h += '<div class="card"><div class="row"><span class="rk">upload</span><span class="rv" style="font-size:11px">POST /drafts/upload {filename, content}</span></div>';
  h += '<div class="row"><span class="rk">commit</span><span class="rv" style="font-size:11px">POST /drafts/commit {message}</span></div>';
  h += '<div class="row"><span class="rk">promote</span><span class="rv" style="font-size:11px">POST /drafts/promote</span></div></div></div>';
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Your pass (AAP)</div>';
  h += '<div class="card"><div class="muted" style="margin-bottom:8px">Contributor pass — your entry point.</div>';
  h += '<div class="actions"><button class="btn btn-ghost" id="copyAAPBtn">&#128203; copy link</button></div></div></div>';
  ROOT.innerHTML = h;
  document.getElementById('copyAAPBtn')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(d.aap_url || location.href).then(() => toast('Copied'));
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────

function showBack(label) {
  BACK.className = 'back-btn show';
  document.getElementById('back-label').textContent = label || 'back';
}
function hideBack() { BACK.className = 'back-btn'; }

BACK.addEventListener('click', () => {
  hideBack();
  if (SAP_STATE) renderSAP(SAP_STATE);
  else load();
});

async function reloadPAP() {
  try {
    const r = await fetch(BASE+'/hub/api/state?token='+encodeURIComponent(STATE.pap_token||TOKEN));
    const d = await r.json();
    if (d.tier==='pap') renderPAP(d);
  } catch(e) { toast('Reload failed','err'); }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function load() {
  if (!TOKEN) {
    ROOT.innerHTML = '<div class="card"><div class="card-head">Open from Telegram</div><div class="muted">This dashboard works inside the Telegram app. Open it via the bot.</div></div>';
    return;
  }
  try {
    const r = await fetch(BASE+'/hub/api/state?token='+encodeURIComponent(TOKEN));
    const d = await r.json();
    STATE = d;
    if (d.tier==='sap')      renderSAP(d);
    else if (d.tier==='pap') renderPAP(d);
    else if (d.tier==='aap') renderAAP(d);
    else ROOT.innerHTML = '<div class="empty">Unknown tier.</div>';
  } catch(e) {
    ROOT.innerHTML = '<div class="card"><div class="card-head">Error</div><div class="muted">'+esc(e.message)+'</div></div>';
  }
}

load();
})();
</script>
</body>
</html>`;
}

// ─── API routes ────────────────────────────────────────────────────────────────

export function mountWebAppRoutes(app, ctx) {
  _ctx = ctx;

  // ── State
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

  // ── Bot sync — pushes name/description/commands from bot.json to Telegram
  app.post('/hub/api/bot/sync', async (req, res) => {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const p = ctx.modules.drafts?.findProjectByPAP(auth);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    if (!p.bot?.token) return res.status(400).json({ ok: false, error: 'no_bot' });

    const token = p.bot.token;
    const base  = ctx.config.publicBase;

    // Load bot.json if it exists
    let botJson = {};
    try {
      const bpath = ctx.config.dataDir + '/projects/' + p.name + '/live/bot.json';
      if (fs.existsSync(bpath)) botJson = JSON.parse(fs.readFileSync(bpath, 'utf8'));
    } catch {}

    const tg = async (method, params) => {
      const r = await fetch('https://api.telegram.org/bot'+token+'/'+method, {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(params),
      });
      return r.json();
    };

    const results = {};
    try {
      // Set name
      if (botJson.name) {
        const r = await tg('setMyName', { name: botJson.name });
        results.name = r.ok;
      }
      // Set description
      if (botJson.description) {
        const r = await tg('setMyDescription', { description: botJson.description });
        results.description = r.ok;
      }
      // Set commands from bot.json.commands array
      if (botJson.commands?.length) {
        const cmds = botJson.commands
          .filter(c => c.command && c.description)
          .map(c => ({ command: c.command.replace(/^\//, ''), description: c.description }));
        if (cmds.length) {
          const r = await tg('setMyCommands', { commands: cmds, scope: { type: 'all_private_chats' } });
          results.commands = r.ok;
        }
      }
      // Set menu button to webapp if live_url exists
      const webappUrl = base + '/hub/webapp?token=' + encodeURIComponent(
        'pass_' + ctx.config.serverNumber + '_project_' + (p.pap?.token?.replace(/^pap_/, '') || '')
      );
      const menuR = await tg('setChatMenuButton', {
        menu_button: { type: 'web_app', text: botJson.menu_button_text || 'Dashboard', web_app: { url: webappUrl } }
      });
      results.menu_button = menuR.ok;

      return res.json({ ok: true, results });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Broadcast — send message to all subscribers
  app.post('/hub/api/broadcast', async (req, res) => {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const p = ctx.modules.drafts?.findProjectByPAP(auth);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    if (!p.bot?.token) return res.status(400).json({ ok: false, error: 'no_bot' });

    const token    = p.bot.token;
    const message  = String(req.body?.message || '').trim();
    const subs     = p.bot.subscribers || [];

    if (!message) {
      // No message = just sync, no broadcast
      return res.json({ ok: true, sent: 0, skipped: 0, reason: 'no_message' });
    }

    let sent = 0, skipped = 0;
    const dead = [];

    for (const sub of subs) {
      const chatId = sub.chat_id || sub.id;
      if (!chatId) { skipped++; continue; }
      try {
        const r = await fetch('https://api.telegram.org/bot'+token+'/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
        });
        const data = await r.json();
        if (data.ok) {
          sent++;
        } else if (data.error_code === 403 || data.error_code === 400) {
          // User blocked bot or chat not found
          dead.push(chatId);
          skipped++;
        } else {
          skipped++;
        }
      } catch {
        skipped++;
      }
    }

    // Prune dead subscribers
    if (dead.length) {
      p.bot.subscribers = subs.filter(s => !dead.includes(s.chat_id || s.id));
      ctx.modules.drafts?.saveState?.();
    }

    ctx.logger.info('[broadcast] '+p.name+': sent='+sent+' skipped='+skipped+' pruned='+dead.length);
    return res.json({ ok: true, sent, skipped, pruned: dead.length });
  });

  // ── Webhook PUT
  app.put('/drafts/project/bot/webhook', async (req, res) => {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const p = ctx.modules.drafts?.findProjectByPAP(auth);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    if (!p.bot?.token) return res.status(400).json({ ok: false, error: 'no_bot' });
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'url_required' });
    try {
      const r = await fetch('https://api.telegram.org/bot'+p.bot.token+'/setWebhook', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ url }),
      });
      const tgRes = await r.json();
      if (!tgRes.ok) throw new Error(tgRes.description);
      p.bot.webhook_url = url;
      ctx.modules.drafts?.saveState?.();
      return res.json({ ok: true });
    } catch(e) { return res.status(400).json({ ok: false, error: e.message }); }
  });

  // ── Webhook DELETE
  app.delete('/drafts/project/bot/webhook', async (req, res) => {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const p = ctx.modules.drafts?.findProjectByPAP(auth);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    if (!p.bot?.token) return res.status(400).json({ ok: false, error: 'no_bot' });
    try {
      await fetch('https://api.telegram.org/bot'+p.bot.token+'/deleteWebhook', { method: 'POST' });
      p.bot.webhook_url = null;
      ctx.modules.drafts?.saveState?.();
      return res.json({ ok: true });
    } catch(e) { return res.status(400).json({ ok: false, error: e.message }); }
  });

  // ── GitHub autosync toggle
  app.put('/drafts/project/github-autosync', (req, res) => {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const p = ctx.modules.drafts?.findProjectByPAP(auth);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    p.github_autosync = !!(req.body?.enabled);
    ctx.modules.drafts?.saveState?.();
    return res.json({ ok: true, enabled: p.github_autosync });
  });

  // ── Webapp HTML shell
  app.get('/hub/webapp', (req, res) => {
    res.type('html').send(renderShell());
  });

  ctx.logger.info('[webapp] routes mounted: /hub/webapp, /hub/api/state, /hub/api/broadcast, /hub/api/bot/sync');
}
