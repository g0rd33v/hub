// modules/drafts/webapp.js
// Telegram Mini App dashboard — full port of telepath renderSAP/renderPAP/renderAAP
//
// Routes:
//   GET  /hub/webapp          — HTML shell (loaded by web_app button in Telegram)
//   GET  /hub/api/state       — JSON state for the shell, auth via ?token=pass_N_...
//   PUT  /hub/api/bot/webhook — set webhook URL
//   DELETE /hub/api/bot/webhook — remove webhook (back to polling)
//   GET  /hub/api/analytics   — per-project analytics

import fs   from 'fs';
import path from 'path';

let _ctx;

function readSAP() {
  try { return fs.readFileSync('/etc/hub/sap.token', 'utf8').trim(); } catch { return ''; }
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function parseToken(req) {
  // Accept token from query string or Authorization header
  const fromQuery = req.query?.token || '';
  const fromHeader = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '');
  const raw = fromQuery || fromHeader;

  const sn = _ctx.config.serverNumber;
  const sap = readSAP();

  // New format: pass_N_server_HEX → SAP
  const newFmt = raw.match(/^pass_(\d+)_([a-z][a-z0-9]*)_(.+)$/);
  if (newFmt) {
    const role = newFmt[2];
    const hex  = newFmt[3];
    if (role === 'server')  return { tier: 'sap', token: hex };
    if (role === 'project') return { tier: 'pap', token: 'pap_' + hex };
    if (role === 'agent')   return { tier: 'aap', token: 'aap_' + hex };
  }
  // Legacy pap_/aap_ prefix
  if (raw.startsWith('pap_')) return { tier: 'pap', token: raw };
  if (raw.startsWith('aap_')) return { tier: 'aap', token: raw };
  // Raw SAP hex
  if (/^[0-9a-f]{12,64}$/i.test(raw) && raw === sap) return { tier: 'sap', token: raw };
  return null;
}

// ─── State endpoint ───────────────────────────────────────────────────────────

function buildSAPState() {
  const st   = _ctx.modules.drafts.getState();
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  const sap  = readSAP();

  return {
    tier: 'sap',
    server: { base, server_number: sn, uptime_sec: Math.floor(process.uptime()) },
    projects: st.projects.map(p => ({
      name:        p.name,
      description: p.description || p.name,
      live_url:    base + '/' + p.name + '/',
      pap_url:     p.pap?.token
        ? base + '/signin/pass_' + sn + '_project_' + p.pap.token.replace(/^pap_/, '')
        : null,
      pap_token:   p.pap?.token || null,
      has_bot:     !!(p.bot?.token),
      bot_username: p.bot?.bot_username || null,
      bot_mode:    p.bot?.webhook_url ? 'webhook' : 'polling',
      subscriber_count: (p.bot?.subscribers || []).length,
      aap_count:   (p.aaps || []).filter(a => !a.revoked).length,
      version_count: 0, // resolved lazily
    })),
  };
}

function buildPAPState(project) {
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  const papSecret = project.pap?.token?.replace(/^pap_/, '');

  return {
    tier:        'pap',
    name:        project.name,
    description: project.description || project.name,
    live_url:    base + '/' + project.name + '/',
    pap_url:     papSecret ? base + '/signin/pass_' + sn + '_project_' + papSecret : null,
    pap_token:   project.pap?.token || null,

    // Bot
    bot: project.bot ? {
      username:     project.bot.bot_username,
      mode:         project.bot.webhook_url ? 'webhook' : 'polling',
      webhook_url:  project.bot.webhook_url || null,
      webhook_log:  (project.bot.webhook_log || []).slice(0, 10),
      subscribers:  (project.bot.subscribers || []).length,
      analytics_enabled: project.bot.analytics_enabled ?? true,
    } : null,

    // GitHub
    github: {
      repo:      project.github_repo || null,
      autosync:  project.github_autosync || false,
    },

    // Contributors
    aaps: (project.aaps || []).filter(a => !a.revoked).map(a => ({
      id:    a.id,
      name:  a.name || a.id,
      url:   base + '/signin/pass_' + sn + '_agent_' + a.token.replace(/^aap_/, ''),
    })),

    // API base for webapp JS calls
    api_base:  base + '/drafts',
  };
}

function buildAAPState(project, aap) {
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  return {
    tier:       'aap',
    name:       project.name,
    aap_name:   aap.name || aap.id,
    branch:     aap.branch,
    live_url:   base + '/' + project.name + '/',
    aap_url:    base + '/signin/pass_' + sn + '_agent_' + aap.token.replace(/^aap_/, ''),
    api_base:   base + '/drafts',
    aap_token:  aap.token,
  };
}

// ─── HTML shell ───────────────────────────────────────────────────────────────
// Full Telegram Mini App SPA. Gets state from /hub/api/state,
// renders SAP / PAP / AAP view in JS.

function renderShell() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Hub dashboard</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--tg-theme-bg-color,#0f0f0f);color:var(--tg-theme-text-color,#f0f0f0);font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--tg-theme-link-color,#60a5fa);text-decoration:none}
#root{padding:16px 16px 80px}
.ey{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#555;margin-bottom:20px}
h1{font-size:26px;font-weight:800;letter-spacing:-.03em;line-height:1.1;margin-bottom:6px}
.lead{font-size:13px;color:#666;margin-bottom:24px}
.divider{border:none;border-top:1px solid rgba(255,255,255,.07);margin:20px 0}
.sec h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:#555;margin-bottom:12px}
.card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:16px;margin-bottom:12px}
.card h3{font-size:14px;font-weight:700;display:flex;align-items:center;gap:8px;margin-bottom:10px}
.dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex-shrink:0}
.dot.off{background:#444}
.tag{font-size:10px;letter-spacing:.07em;text-transform:uppercase;padding:2px 7px;border-radius:4px;background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.2)}
.tag.off{background:rgba(255,255,255,.04);color:#444;border-color:rgba(255,255,255,.07)}
.row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.05)}
.row:last-child{border-bottom:none}
.row-key{font-size:12px;color:#555;flex-shrink:0;width:96px}
.row-val{font-size:12px;color:#aaa;word-break:break-all}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
btn,.btn{font-size:13px;font-weight:600;padding:9px 16px;border-radius:9px;border:1px solid rgba(255,255,255,.1);background:transparent;color:#aaa;cursor:pointer;white-space:nowrap}
.btn:active{opacity:.7}
.btn-full{background:#fff;color:#000;border-color:#fff;width:100%;text-align:center;display:block;padding:11px}
.btn-full:active{background:#ddd}
.btn-danger{border-color:rgba(248,113,113,.3);color:#f87171}
.btn-ghost{border-color:rgba(255,255,255,.12);color:#888}
input[type=text],input[type=url]{width:100%;background:#111;border:1px solid rgba(255,255,255,.1);color:#f0f0f0;padding:9px 12px;border-radius:8px;font-size:13px;margin-bottom:8px}
input:focus{outline:none;border-color:rgba(255,255,255,.3)}
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0}
.toggle{width:44px;height:24px;border-radius:12px;background:#333;position:relative;cursor:pointer;flex-shrink:0;border:none;outline:none}
.toggle.on{background:#4ade80}
.toggle::after{content:'';position:absolute;width:18px;height:18px;border-radius:9px;background:#fff;top:3px;left:3px;transition:left .15s}
.toggle.on::after{left:23px}
.log-table{width:100%;font-size:11px;border-collapse:collapse;margin-top:8px}
.log-table td{padding:4px 6px;border-bottom:1px solid rgba(255,255,255,.05)}
.log-status.ok{color:#4ade80}
.log-status.err{color:#f87171}
.log-time{color:#555}
.project-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer}
.project-row:last-child{border-bottom:none}
.project-row:active{opacity:.6}
.project-name{font-size:14px;font-weight:700}
.project-meta{font-size:12px;color:#555;margin-top:2px}
.chevron{color:#444;font-size:18px}
.empty{text-align:center;padding:40px 16px;color:#444;font-size:14px}
.muted{font-size:12px;color:#555;line-height:1.5}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.85);border:1px solid rgba(255,255,255,.15);color:#f0f0f0;padding:9px 18px;border-radius:20px;font-size:13px;z-index:999;pointer-events:none;opacity:0;transition:opacity .2s}
.toast.show{opacity:1}
footer{position:fixed;bottom:0;left:0;right:0;height:54px;background:var(--tg-theme-bg-color,#0f0f0f);border-top:1px solid rgba(255,255,255,.07);display:flex;align-items:center;justify-content:center;font-size:11px;color:#333;font-family:ui-monospace,monospace;letter-spacing:.05em}
.back-btn{display:none;position:fixed;top:env(safe-area-inset-top,0);left:0;right:0;height:44px;background:var(--tg-theme-bg-color,#0f0f0f);border-bottom:1px solid rgba(255,255,255,.07);align-items:center;padding:0 16px;gap:10px;font-size:14px;cursor:pointer;z-index:100}
.back-btn.show{display:flex}
</style>
</head>
<body>
<div id="back-nav" class="back-btn"><span style="font-size:18px">&#8249;</span><span id="back-label">back</span></div>
<div id="root"><div class="empty">loading&hellip;</div></div>
<footer>hub &middot; built with hub.labs.co</footer>
<div id="toast" class="toast"></div>
<script>
(function(){
'use strict';
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const ROOT = document.getElementById('root');
const BACK = document.getElementById('back-nav');
const TOAST = document.getElementById('toast');

// Get token from URL: /hub/webapp?token=...
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const BASE = location.origin;
let STATE = null;
let __sapNavStack = false;

function esc(s) {
  if (s==null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg, type) {
  TOAST.textContent = msg;
  TOAST.className = 'toast show' + (type==='err' ? ' err' : '');
  clearTimeout(TOAST._t);
  TOAST._t = setTimeout(() => { TOAST.className = 'toast'; }, 2800);
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.floor(diff/1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  return Math.floor(diff/3600000) + 'h ago';
}

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: {
      'Authorization': 'Bearer ' + STATE.pap_token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// ── SAP view ──────────────────────────────────────────────────────────────────
function renderSAP(d) {
  let h = '<div class="ey">HUB &middot; SERVER ROOT &middot; SAP</div>';
  h += '<h1>Server dashboard.</h1>';
  const up = Math.floor(d.server.uptime_sec / 60);
  h += '<p class="lead">' + d.projects.length + ' project' + (d.projects.length!==1?'s':'') + ' &middot; up ' + up + 'm</p>';

  if (!d.projects.length) {
    h += '<div class="empty">No projects yet.</div>';
  } else {
    d.projects.forEach(p => {
      h += '<div class="project-row" data-name="' + esc(p.name) + '">';
      h += '<div><div class="project-name">' + esc(p.description) + '</div>';
      h += '<div class="project-meta">' + esc(p.name) + (p.has_bot ? ' &middot; @' + esc(p.bot_username) : '') + '</div></div>';
      h += '<div style="display:flex;align-items:center;gap:8px">';
      if (p.has_bot) h += '<span class="tag">bot</span>';
      h += '<span class="chevron">&#8250;</span></div>';
      h += '</div>';
    });
  }
  ROOT.innerHTML = h;
  document.querySelectorAll('.project-row').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-name');
      __sapNavStack = true;
      showBack('server');
      try {
        const papToken = d.projects.find(p=>p.name===name)?.pap_token;
        if (!papToken) { toast('no PAP token', 'err'); return; }
        const r = await fetch(BASE+'/hub/api/state?token='+encodeURIComponent(papToken));
        const pd = await r.json();
        if (pd.tier==='pap') renderPAP(pd);
        else toast('failed to load', 'err');
      } catch(e) { __sapNavStack=false; hideBack(); toast('error: '+e.message,'err'); }
    });
  });
}

// ── PAP view ──────────────────────────────────────────────────────────────────
function renderPAP(d) {
  STATE.pap_token = d.pap_token || STATE.pap_token;
  let h = '<div class="ey">HUB &middot; ' + esc(d.name.toUpperCase()) + ' &middot; PAP</div>';
  h += '<h1>' + esc(d.description) + '</h1>';
  h += '<p class="lead"><a href="' + esc(d.live_url) + '" target="_blank">' + esc(d.live_url) + '</a></p>';

  // ── Bot card
  h += '<hr class="divider"><div class="sec"><h2>Bot</h2>';
  if (d.bot) {
    h += '<div class="card">';
    h += '<h3><span class="dot"></span>@' + esc(d.bot.username) + '<span class="tag">' + esc(d.bot.mode) + '</span></h3>';
    h += '<div class="row"><span class="row-key">subscribers</span><span class="row-val">' + d.bot.subscribers + '</span></div>';
    if (d.bot.mode === 'webhook') {
      h += '<div class="row"><span class="row-key">webhook</span><span class="row-val">' + esc(d.bot.webhook_url) + '</span></div>';
      if (d.bot.webhook_log?.length) {
        h += '<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#555;margin:10px 0 4px">recent calls</div>';
        h += '<table class="log-table">';
        d.bot.webhook_log.forEach(e => {
          const ok = e.status >= 200 && e.status < 300;
          const t = e.status > 0 ? String(e.status) : (e.error || 'err');
          h += '<tr><td class="log-time">' + timeAgo(e.at) + '</td>';
          h += '<td class="log-status ' + (ok?'ok':'err') + '">' + esc(t) + '</td>';
          h += '<td>' + (e.latency_ms||'') + 'ms</td></tr>';
        });
        h += '</table>';
      }
    }
    h += '<div class="actions">';
    if (d.bot.mode === 'polling') {
      h += '<button class="btn btn-ghost" id="webhookModeBtn">&#8645; enable webhook</button>';
    } else {
      h += '<button class="btn btn-ghost" id="webhookModeBtn">&#8645; switch to polling</button>';
    }
    h += '<button class="btn btn-danger" id="unlinkBotBtn">unlink</button>';
    h += '</div>';
    if (d.bot.mode === 'polling') {
      h += '<div style="margin-top:12px"><input type="url" id="webhookInput" placeholder="https://your-app.vercel.app/webhook"></div>';
    }
    h += '</div>';
  } else {
    h += '<div class="card">';
    h += '<div class="muted" style="margin-bottom:12px">No bot linked to this project.</div>';
    h += '<input type="text" id="botTokenInput" placeholder="Paste BotFather token">';
    h += '<div class="actions"><button class="btn btn-full" id="linkBotBtn">link bot</button></div>';
    h += '</div>';
  }
  h += '</div>';

  // ── GitHub card
  h += '<hr class="divider"><div class="sec"><h2>GitHub</h2><div class="card">';
  h += '<h3><span class="dot ' + (d.github.repo?'':'off') + '"></span>github</h3>';
  if (d.github.repo) {
    h += '<div class="row"><span class="row-key">repo</span><span class="row-val">' + esc(d.github.repo) + '</span></div>';
    h += '<div class="toggle-row"><div><div style="font-size:13px;font-weight:600">auto-sync</div><div class="muted">push to GitHub on every commit</div></div>';
    h += '<button class="toggle ' + (d.github.autosync?'on':'') + '" id="autosyncToggle"></button></div>';
    h += '<div class="actions">';
    h += '<button class="btn btn-ghost" id="githubSyncBtn">&#8593; push now</button>';
    h += '<button class="btn btn-danger" id="githubUnlinkBtn">unlink</button>';
    h += '</div>';
  } else {
    h += '<input type="text" id="githubRepoInput" placeholder="owner/repo">';
    h += '<div class="actions"><button class="btn btn-full" id="githubLinkBtn">&#128279; link repo</button></div>';
  }
  h += '</div></div>';

  // ── Contributors
  if (d.aaps?.length) {
    h += '<hr class="divider"><div class="sec"><h2>Contributors (' + d.aaps.length + ')</h2>';
    d.aaps.forEach(a => {
      h += '<div class="card"><div class="row"><span class="row-key">' + esc(a.name) + '</span>';
      h += '<span class="row-val"><a href="' + esc(a.url) + '">dashboard</a></span></div></div>';
    });
    h += '</div>';
  }

  // ── This link
  h += '<hr class="divider"><div class="sec"><h2>This link (PAP)</h2>';
  h += '<div class="card"><p class="muted">Your project pass. Bookmark it.</p>';
  h += '<div class="actions"><button class="btn" id="copyPAPBtn">&#128203; copy link</button></div></div>';
  h += '<p class="muted" style="margin-top:8px">Mint contributor pass: <code>POST /drafts/aaps {name}</code></p>';
  h += '</div>';

  ROOT.innerHTML = h;

  // Wire up events
  const apiBase = d.api_base || (location.origin + '/drafts');

  // Link / unlink bot
  document.getElementById('linkBotBtn')?.addEventListener('click', async () => {
    const t = document.getElementById('botTokenInput')?.value.trim();
    if (!t) return;
    try {
      const r = await api('PUT', apiBase+'/project/bot', { token: t });
      if (r.ok) { toast('bot linked: @'+r.bot.bot_username); setTimeout(reload,600); }
      else toast('failed: '+(r.detail||r.error), 'err');
    } catch(e) { toast('error: '+e.message,'err'); }
  });

  document.getElementById('unlinkBotBtn')?.addEventListener('click', async () => {
    if (!confirm('Unlink bot?')) return;
    try {
      const r = await api('DELETE', apiBase+'/project/bot');
      if (r.ok) { toast('bot unlinked'); setTimeout(reload,600); }
      else toast('failed: '+r.error, 'err');
    } catch(e) { toast('error: '+e.message,'err'); }
  });

  // Webhook toggle
  document.getElementById('webhookModeBtn')?.addEventListener('click', async () => {
    if (d.bot.mode === 'polling') {
      const url = document.getElementById('webhookInput')?.value.trim();
      if (!url) { toast('enter webhook URL first'); return; }
      try {
        const r = await api('PUT', apiBase+'/project/bot/webhook', { url });
        if (r.ok) { toast('webhook enabled'); setTimeout(reload,600); }
        else toast('failed: '+(r.detail||r.error),'err');
      } catch(e) { toast('error: '+e.message,'err'); }
    } else {
      try {
        const r = await api('DELETE', apiBase+'/project/bot/webhook');
        if (r.ok) { toast('switched to polling'); setTimeout(reload,600); }
        else toast('failed: '+r.error,'err');
      } catch(e) { toast('error: '+e.message,'err'); }
    }
  });

  // GitHub
  document.getElementById('githubLinkBtn')?.addEventListener('click', async () => {
    const repo = document.getElementById('githubRepoInput')?.value.trim();
    if (!repo) return;
    // For GitHub we need SAP auth — show info
    toast('GitHub link requires SAP token — use the web dashboard');
  });

  document.getElementById('githubSyncBtn')?.addEventListener('click', async () => {
    try {
      const r = await api('POST', apiBase+'/github/sync', {});
      if (r.ok) toast('pushed to GitHub');
      else toast('failed: '+(r.error||r.detail),'err');
    } catch(e) { toast('error: '+e.message,'err'); }
  });

  document.getElementById('autosyncToggle')?.addEventListener('click', async function() {
    const next = !d.github.autosync;
    d.github.autosync = next;
    this.className = 'toggle ' + (next?'on':'');
    try {
      await api('PUT', apiBase+'/project/github-autosync', { enabled: next });
      toast(next ? 'auto-sync on' : 'auto-sync off');
    } catch(e) { toast('error: '+e.message,'err'); }
  });

  document.getElementById('githubUnlinkBtn')?.addEventListener('click', async () => {
    if (!confirm('Unlink GitHub repo?')) return;
    toast('Use web dashboard to unlink GitHub');
  });

  // Copy PAP
  document.getElementById('copyPAPBtn')?.addEventListener('click', () => {
    const url = d.pap_url || location.href;
    navigator.clipboard?.writeText(url).then(() => toast('URL copied \u2713'))
      .catch(() => toast('copy: ' + url.slice(0,40)+'...'));
  });
}

// ── AAP view ──────────────────────────────────────────────────────────────────
function renderAAP(d) {
  let h = '<div class="ey">HUB &middot; ' + esc(d.name.toUpperCase()) + ' &middot; AAP</div>';
  h += '<h1>' + esc(d.aap_name) + '</h1>';
  h += '<p class="lead">Contributor on <a href="' + esc(d.live_url) + '">' + esc(d.name) + '</a> &middot; branch: <code>' + esc(d.branch) + '</code></p>';
  h += '<hr class="divider"><div class="sec"><h2>Build loop</h2>';
  h += '<div class="card"><pre style="font-size:12px;color:#666;line-height:1.8">POST /drafts/upload  {filename, content}\nPOST /drafts/commit  {message}</pre></div>';
  h += '</div><hr class="divider"><div class="sec"><h2>Your pass (AAP)</h2>';
  h += '<div class="card"><p class="muted">Your contributor pass.</p>';
  h += '<div class="actions"><button class="btn" id="copyAAPBtn">&#128203; copy link</button></div></div>';
  h += '</div>';
  ROOT.innerHTML = h;
  document.getElementById('copyAAPBtn')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(d.aap_url || location.href).then(() => toast('copied \u2713'));
  });
}

// ── Navigation helpers ────────────────────────────────────────────────────────
function showBack(label) {
  BACK.className = 'back-btn show';
  document.getElementById('back-label').textContent = label || 'back';
}
function hideBack() {
  BACK.className = 'back-btn';
  __sapNavStack = false;
}
BACK.addEventListener('click', () => {
  hideBack();
  load();
});

async function reload() {
  const r = await fetch(BASE+'/hub/api/state?token='+encodeURIComponent(TOKEN));
  const d = await r.json();
  if (d.tier==='pap') renderPAP(d);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function load() {
  if (!TOKEN) {
    ROOT.innerHTML = '<div class="card"><h3>open from Telegram</h3><div class="muted">This only works inside the Telegram app. Open it via the bot.</div></div>';
    return;
  }
  try {
    const r = await fetch(BASE+'/hub/api/state?token='+encodeURIComponent(TOKEN));
    const d = await r.json();
    STATE = d;
    if (d.tier==='sap') renderSAP(d);
    else if (d.tier==='pap') renderPAP(d);
    else if (d.tier==='aap') renderAAP(d);
    else ROOT.innerHTML = '<div class="empty">unknown tier</div>';
  } catch(e) {
    ROOT.innerHTML = '<div class="card"><h3>error</h3><div class="muted">'+esc(e.message)+'</div></div>';
  }
}

load();
})();
</script>
</body>
</html>`;
}

// ─── Mount routes ─────────────────────────────────────────────────────────────

export function mountWebAppRoutes(app, ctx) {
  _ctx = ctx;

  // State API
  app.get('/hub/api/state', (req, res) => {
    const parsed = parseToken(req);
    if (!parsed) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const { tier, token } = parsed;

    if (tier === 'sap') {
      const sap = readSAP();
      if (token !== sap) return res.status(401).json({ ok: false, error: 'unauthorized' });
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

  // Webhook API (used by webapp JS)
  app.put('/drafts/project/bot/webhook', async (req, res) => {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const p = ctx.modules.drafts?.findProjectByPAP(auth);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    if (!p.bot?.token) return res.status(400).json({ ok: false, error: 'no_bot' });
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'url_required' });
    try {
      const r = await fetch('https://api.telegram.org/bot'+p.bot.token+'/setWebhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const tgRes = await r.json();
      if (!tgRes.ok) throw new Error(tgRes.description);
      p.bot.webhook_url = url;
      ctx.modules.drafts?.saveState?.();
      return res.json({ ok: true });
    } catch(e) { return res.status(400).json({ ok: false, error: e.message }); }
  });

  app.delete('/drafts/project/bot/webhook', async (req, res) => {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
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

  // GitHub autosync toggle
  app.put('/drafts/project/github-autosync', (req, res) => {
    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const p = ctx.modules.drafts?.findProjectByPAP(auth);
    if (!p) return res.status(404).json({ ok: false, error: 'project_not_found' });
    p.github_autosync = !!(req.body?.enabled);
    ctx.modules.drafts?.saveState?.();
    return res.json({ ok: true, enabled: p.github_autosync });
  });

  // Webapp HTML shell
  app.get('/hub/webapp', (req, res) => {
    res.type('html').send(renderShell());
  });

  ctx.logger.info('[webapp] routes mounted: /hub/webapp, /hub/api/state');
}
