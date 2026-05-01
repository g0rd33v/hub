// modules/drafts/static.js — static file serving + signin page rendering
// Lifted from drafts/drafts.js (serveStatic, renderProjectLanding, renderPage).

import fs   from 'fs';
import fsp  from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { projectPaths, findProjectByName, sanitizeName, isReservedName } from './projects.js';
import { listVersions } from './git.js';
import { hasRoutesJs } from '../../modules/runtime/routes.js';

const MIME = {
  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8',
  '.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.mjs':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8',
  '.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8',
  '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon',
  '.mp3':'audio/mpeg','.mp4':'video/mp4','.webm':'video/webm','.pdf':'application/pdf',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf',
};

function mimeFor(f) { return MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'; }

function resolveSafe(root, rel) {
  const cleaned = rel.replace(/\.\.\/+/g, '').replace(/^\/+/, '');
  const full    = path.resolve(root, cleaned);
  return full.startsWith(path.resolve(root)) ? full : null;
}

export function serveStatic(rootDir, relPath, res) {
  const full = resolveSafe(rootDir, relPath);
  if (!full) return res.status(400).type('text/plain').send('bad path');
  if (!fs.existsSync(full)) return res.status(404).type('text/plain').send('not found');
  let target = full;
  let stat   = fs.statSync(target);
  if (stat.isDirectory()) {
    const idx = path.join(target, 'index.html');
    if (fs.existsSync(idx) && fs.statSync(idx).isFile()) { target = idx; stat = fs.statSync(target); }
    else return res.status(404).type('text/plain').send('no index.html');
  }
  res.set('Content-Type', mimeFor(target));
  res.set('Cache-Control', 'public, max-age=60');
  res.set('Last-Modified', stat.mtime.toUTCString());
  return fs.createReadStream(target).pipe(res);
}

// Hub fallback landing page (shown when project has no index.html)
export function renderProjectLanding(projectName, publicBase) {
  const bot    = projectName;
  const tg     = 'https://t.me/' + bot;
  const hub    = 'https://hub.labs.co';
  const hubBot = 'https://t.me/LabsHubBot';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>@${bot} · Hub</title>
<style>*{box-sizing:border-box;margin:0;padding:0}html,body{background:#000;color:#f5f5f5;font-family:Inter,-apple-system,sans-serif;font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}.wrap{max-width:720px;margin:0 auto;padding:80px 24px 96px}.hero{text-align:center;margin-bottom:80px}.hero .at{font-size:13px;letter-spacing:.18em;color:#555;text-transform:uppercase;font-weight:600;margin-bottom:16px}.hero h1{font-size:56px;font-weight:800;letter-spacing:-.04em;line-height:1;margin-bottom:16px;word-break:break-word}.hero .sub{font-size:14px;color:#888;margin-bottom:32px}.cta{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#000;padding:14px 24px;border-radius:12px;font-weight:700;font-size:14px}.bottom{text-align:center;padding-top:48px;border-top:1px solid rgba(255,255,255,.06)}.bottom .links{display:flex;gap:20px;justify-content:center;margin-bottom:20px}.bottom a{font-size:13px;font-weight:600;color:#f5f5f5;display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border:1px solid rgba(255,255,255,.1);border-radius:9px}.foot{font-size:12px;color:#444}.how-to{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:16px 18px;margin:24px 20px 0;font-size:13px;text-align:left}.how-to-title{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#666;margin-bottom:10px}.how-to-steps{list-style:none;counter-reset:s;padding:0;margin:0}.how-to-steps li{counter-increment:s;display:flex;align-items:center;gap:10px;padding:6px 0;color:#999;border-bottom:1px solid rgba(255,255,255,.06);font-size:13px}.how-to-steps li:last-child{border-bottom:none}.how-to-steps li::before{content:"0" counter(s);font-family:ui-monospace,monospace;font-size:11px;color:#ff6a3d;min-width:18px}.how-to-note{margin-top:10px;color:#555;font-size:12px}</style>
</head><body><div class="wrap">
<div class="hero"><div class="at">Telegram bot</div><h1>@${bot}</h1><div class="sub">Created and managed with Hub</div>
<a href="${tg}" class="cta"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M21.92 4.27a.75.75 0 0 0-.81-.13L2.65 11.7a.75.75 0 0 0 .04 1.4l4.71 1.7 1.81 5.71a.75.75 0 0 0 1.27.27l2.74-2.95 4.71 3.45a.75.75 0 0 0 1.18-.42l3.05-15.92a.75.75 0 0 0-.24-.67Z"/></svg>Open in Telegram</a></div>
<div class="bottom"><div class="links"><a href="${hubBot}">@LabsHubBot</a><a href="${hub}">hub.labs.co</a></div><div class="foot">@${bot} on Hub</div></div>

<div class="how-to">
  <div class="how-to-title">How to use this link</div>
  <ol class="how-to-steps">
    <li>Open Chrome</li>
    <li>Launch the Claude for Chrome extension</li>
    <li>Drop this link into the chat</li>
  </ol>
  <div class="how-to-note">Claude will take it from there.</div>
</div></div></body></html>`;
}

// Signin page rendering — delegates to renderPage from drafts.js
// In v0.2 the renderPage function is preserved as-is; it's large but correct.
// Full rewrite deferred to v0.3.
let _ctx;
export function init(ctx) { _ctx = ctx; }

export async function renderSignin(req, res, { tier, token }) {
  const sapToken = (() => { try { return fs.readFileSync('/etc/hub/sap.token','utf8').trim(); } catch { return null; } })();
  if (tier === 'sap') {
    if (token !== sapToken) return res.status(404).send('not found');
    return res.type('html').send(renderSAPPage());
  }
  if (tier === 'pap') {
    const p = _ctx.modules.drafts.findProjectByPAP(token);
    if (!p) return res.status(404).send('not found');
    const versions = await listVersions(p.name);
    return res.type('html').send(renderPAPPage(p, versions));
  }
  if (tier === 'aap') {
    const hit = _ctx.modules.drafts.findProjectAndAAPByAAPToken(token);
    if (!hit) return res.status(404).send('not found');
    const versions = await listVersions(hit.project.name);
    return res.type('html').send(renderAAPPage(hit.project, hit.aap, versions));
  }
  return res.status(404).send('not found');
}

function esc(s) { if (s==null) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Minimal signin pages — functional, correct, styled.
// Full buffer-style redesign in v0.3.
function signinCSS() {
  return `<style>*{box-sizing:border-box;margin:0;padding:0}html,body{background:#000;color:#f5f5f5;font-family:Inter,system-ui,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}a{color:#a8a8a8;text-underline-offset:3px}code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;background:rgba(255,255,255,.06);padding:1px 6px;border-radius:4px}.wrap{max-width:720px;margin:0 auto;padding:64px 28px 96px}.ey{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#a8a8a8;margin-bottom:32px}h1{font-size:48px;font-weight:700;letter-spacing:-.035em;line-height:1.05;margin-bottom:20px}.lead{font-size:16px;color:#a8a8a8;margin-bottom:0;max-width:560px}.div{border-top:1px solid rgba(255,255,255,.07);margin:40px 0 28px}.sec h2{font-size:22px;font-weight:700;margin-bottom:14px}.sec p{font-size:14px;color:#a8a8a8;margin-bottom:12px}pre{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:12px 14px;overflow-x:auto;color:#d4d4d4;margin:8px 0}.tbl{width:100%;border-collapse:collapse;font-size:13px}.tbl th{text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a6a;padding:8px;border-bottom:1px solid rgba(255,255,255,.07)}.tbl td{padding:12px 8px;border-bottom:1px solid rgba(255,255,255,.04);color:#d4d4d4}.tbl td.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}.tbl a{color:#a8a8a8}footer{margin-top:56px;padding-top:20px;border-top:1px solid rgba(255,255,255,.07);display:flex;justify-content:space-between;font-size:12px;color:#6a6a6a;font-family:ui-monospace,Menlo,monospace}footer a{color:#a8a8a8;text-decoration:none}.how-to{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:16px 18px;margin:20px 0 0;font-size:13px}.how-to-title{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#555;margin-bottom:10px}.how-to-steps{list-style:none;counter-reset:s;padding:0}.how-to-steps li{counter-increment:s;display:flex;align-items:center;gap:10px;padding:6px 0;color:#888;border-bottom:1px solid rgba(255,255,255,.05)}.how-to-steps li:last-child{border-bottom:none}.how-to-steps li::before{content:"0" counter(s);font-family:ui-monospace,monospace;font-size:11px;color:#ff6a3d;min-width:18px}.how-to-note{margin-top:10px;color:#555;font-size:12px}</style>`;
}


function renderSAPPage() {
  const st   = _ctx.modules.drafts.getState();
  const base = _ctx.config.publicBase;
  const sn   = _ctx.config.serverNumber;
  const sap  = (() => { try { return fs.readFileSync('/etc/hub/sap.token','utf8').trim(); } catch { return ''; } })();
  const upMin = Math.floor(process.uptime()/60);
  const botCount = st.projects.filter(p=>p.bot&&p.bot.token).length;

  let cards = '';
  for (const p of st.projects) {
    const papSecret = p.pap && p.pap.token ? p.pap.token.replace(/^pap_/,'') : null;
    const papUrl = papSecret ? base+'/signin/pass_'+sn+'_project_'+papSecret : null;
    const liveUrl = base+'/'+p.name+'/';
    const hasBot = !!(p.bot && p.bot.token);
    const botTag = hasBot ? ' &middot; @'+esc(p.bot.bot_username) : '';
    const aapCount = (p.aaps||[]).filter(a=>!a.revoked).length;
    cards += `<div class="card">`
      +`<div class="card-top"><div class="card-name">${esc(p.description||p.name)}</div>`
      +`<span class="tag ${hasBot?'tag-on':'tag-off'}">${hasBot?'bot active':'no bot'}</span></div>`
      +`<div class="card-meta">${esc(p.name)}${botTag}</div>`
      +`<div class="card-links">`
      +`<a href="${liveUrl}" target="_blank" class="link-item"><span class="link-ico">&#9654;</span>live</a>`
      +`${papUrl?`<a href="${papUrl}" class="link-item"><span class="link-ico">&#9881;</span>dashboard</a>`:''}`
      +`${aapCount?`<span class="link-item muted">${aapCount} contributor${aapCount!==1?'s':''}</span>`:''}`
      +`</div></div>`;
  }
  if (!cards) cards = '<div class="empty">No projects yet.</div>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Hub &middot; Server Root</title>${signinCSS()}<style>
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin:28px 0}
.card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:20px;display:flex;flex-direction:column;gap:10px}
.card:hover{border-color:rgba(255,255,255,.13)}
.card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.card-name{font-size:15px;font-weight:700;letter-spacing:-.02em}
.card-meta{font-size:12px;color:#5a5a5a}
.card-links{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.link-item{font-size:12px;color:#6a6a6a;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);border-radius:6px;padding:4px 10px;display:flex;align-items:center;gap:5px;text-decoration:none}
.link-item:hover{color:#d0d0d0;border-color:rgba(255,255,255,.14)}
.link-ico{font-size:10px}
.muted{cursor:default}
.tag{font-size:10px;letter-spacing:.07em;text-transform:uppercase;padding:2px 7px;border-radius:4px;flex-shrink:0}
.tag-on{background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.2)}
.tag-off{background:rgba(255,255,255,.04);color:#444;border:1px solid rgba(255,255,255,.06)}
.empty{padding:40px;text-align:center;color:#333;font-size:14px}
.server-info{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);border-radius:10px;padding:20px;margin-top:12px;font-size:13px}
.si-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.si-row:last-child{border-bottom:none}
.si-key{color:#444}.si-val{color:#777;font-family:ui-monospace,monospace;font-size:12px}
</style></head><body><div class="wrap">
<div class="ey">HUB &middot; SERVER ROOT &middot; SAP</div>
<h1>Server dashboard.</h1>
<p class="lead">${st.projects.length} project${st.projects.length!==1?'s':''} &middot; ${botCount} bot${botCount!==1?'s':''} active &middot; up ${upMin}m</p>
<div class="div"></div>
<div class="sec"><h2>Projects</h2><div class="grid">${cards}</div></div>
<div class="div"></div>
<div class="sec"><h2>Server</h2><div class="server-info">
<div class="si-row"><span class="si-key">Base URL</span><span class="si-val">${esc(base)}</span></div>
<div class="si-row"><span class="si-key">SAP token</span><span class="si-val">${sap.slice(0,4)}&bull;&bull;&bull;&bull;${sap.slice(-4)}</span></div>
<div class="si-row"><span class="si-key">Uptime</span><span class="si-val">${upMin}m</span></div>
</div></div>
<footer><div>hub v0.2 &middot; SAP</div><div><a href="${base}/docs">docs</a></div></footer>
</div></body></html>`;
}

function renderPAPPage(project, versions) {
  const base      = _ctx.config.publicBase;
  const sn        = _ctx.config.serverNumber;
  const liveUrl   = base+'/'+project.name+'/';
  const papSecret = project.pap && project.pap.token ? project.pap.token.replace(/^pap_/,'') : '';
  const papUrl    = papSecret ? base+'/signin/pass_'+sn+'_project_'+papSecret : '';
  const hasBot    = !!(project.bot && project.bot.token);
  const botName   = hasBot ? '@'+project.bot.bot_username : null;
  const botMode   = hasBot ? (project.bot.webhook_url ? 'webhook' : 'polling') : null;
  const subCount  = hasBot ? (project.bot.subscribers||[]).length : 0;
  const aapCount  = (project.aaps||[]).filter(a=>!a.revoked).length;
  const verCount  = versions.length;

  let verRows = '';
  for (const N of [...versions].reverse().slice(0,8)) {
    const isLatest = N === versions[versions.length-1];
    verRows += `<tr><td class="mono">v${N}</td>`
      +`<td>${isLatest?'<span style="color:#4ade80">live</span>':'archived'}</td>`
      +`<td><a href="${base}/${esc(project.name)}/v/${N}/" target="_blank">view</a></td></tr>`;
  }

  let aapRows = '';
  for (const a of (project.aaps||[]).filter(x=>!x.revoked)) {
    const as = a.token.replace(/^aap_/,'');
    aapRows += `<tr><td>${esc(a.name||a.id)}</td><td><a href="${base}/signin/pass_${sn}_agent_${as}">dashboard</a></td></tr>`;
  }

  const botSection = hasBot
    ? `<div class="bot-card on">`
      +`<div class="bot-head"><div><div class="bot-name">${esc(botName)}</div><div class="bot-meta">${botMode} &middot; ${subCount} subscriber${subCount!==1?'s':''}</div></div>`
      +`<span class="tag tag-on">${botMode}</span></div>`
      +`<div class="bot-actions">`
      +`<a href="https://t.me/${esc(project.bot.bot_username)}" target="_blank" class="btn-primary">Open in Telegram</a>`
      +`<button onclick="unlinkBot()" class="btn-danger">Unlink</button>`
      +`</div></div>`
    : `<div class="bot-card off">`
      +`<div class="bot-meta" style="margin-bottom:14px">No bot linked to this project.</div>`
      +`<form onsubmit="linkBot(event)" style="display:flex;gap:8px">`
      +`<input id="bt" type="text" placeholder="Paste BotFather token" style="flex:1;background:#111;border:1px solid rgba(255,255,255,.1);color:#f0f0f0;padding:8px 12px;border-radius:7px;font-size:13px">`
      +`<button type="submit" class="btn-primary">Link bot</button>`
      +`</form></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Hub &middot; ${esc(project.description||project.name)}</title>${signinCSS()}<style>
.bot-card{border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:20px;margin:20px 0;max-width:520px}
.bot-card.on{border-color:rgba(74,222,128,.2)}
.bot-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.bot-name{font-size:15px;font-weight:700;letter-spacing:-.02em}
.bot-meta{font-size:13px;color:#555;margin-top:2px}
.bot-actions{display:flex;gap:10px;flex-wrap:wrap}
.btn-primary{font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;background:#fff;color:#000;border:none;cursor:pointer;text-decoration:none;display:inline-block}
.btn-primary:hover{background:#ddd}
.btn-danger{font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;background:transparent;color:#f87171;border:1px solid rgba(248,113,113,.3);cursor:pointer}
.btn-danger:hover{background:rgba(248,113,113,.1)}
.tag{font-size:10px;letter-spacing:.07em;text-transform:uppercase;padding:2px 7px;border-radius:4px}
.tag-on{background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.2)}
.pap-box{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:12px 16px;font-family:ui-monospace,monospace;font-size:12px;color:#666;word-break:break-all;margin:12px 0}
.build-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
</style></head><body><div class="wrap">
<div class="ey">HUB &middot; ${esc(project.name.toUpperCase())} &middot; PAP</div>
<h1>${esc(project.description||project.name)}</h1>
<p class="lead">Live at <a href="${liveUrl}" target="_blank">${liveUrl}</a> &middot; ${verCount} version${verCount!==1?'s':''} &middot; ${aapCount} contributor${aapCount!==1?'s':''} &middot; bot: ${hasBot?botMode:'none'}</p>
<div class="div"></div>
<div class="sec"><h2>Bot</h2>${botSection}</div>
<div class="div"></div>
<div class="sec"><h2>Build loop</h2><pre>POST /drafts/upload  {filename, content}   # upload file
POST /drafts/commit  {message}             # commit to main
POST /drafts/promote                       # publish to live</pre>
<div class="build-actions">
<a href="${liveUrl}" target="_blank" class="btn-primary">Open live</a>
<button onclick="doPromote()" class="btn-primary" style="background:#111;color:#f0f0f0;border:1px solid rgba(255,255,255,.1)">Promote draft</button>
</div></div>
${verCount?`<div class="div"></div><div class="sec"><h2>Versions</h2><table class="tbl"><thead><tr><th>Ver</th><th>State</th><th>URL</th></tr></thead><tbody>${verRows}</tbody></table></div>`:''}
${aapCount?`<div class="div"></div><div class="sec"><h2>Contributors</h2><table class="tbl"><thead><tr><th>Name</th><th>Dashboard</th></tr></thead><tbody>${aapRows}</tbody></table></div>`:''}
<div class="div"></div>
<div class="sec"><h2>This link</h2><p>Your project pass (PAP). Bookmark it:</p><div class="pap-box">${esc(papUrl)}</div>
<p>Mint contributor passes: <code>POST /drafts/aaps {name}</code></p></div>

<div class="how-to">
  <div class="how-to-title">How to use this link</div>
  <ol class="how-to-steps">
    <li>Open Chrome</li>
    <li>Launch the Claude for Chrome extension</li>
    <li>Drop this link into the chat</li>
  </ol>
  <div class="how-to-note">Claude will take it from there.</div>
</div><footer><div>hub v0.2 &middot; PAP &middot; ${esc(project.name)}</div><div><a href="${liveUrl}" target="_blank">live</a> &middot; <a href="${base}/docs">docs</a></div></footer>
</div>
<script>
const PAP='${papSecret?'pap_'+papSecret:''}', BASE='${base}';
async function api(m,u,b){const r=await fetch(u,{method:m,headers:{'Authorization':'Bearer '+PAP,'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return r.json();}
async function linkBot(e){e.preventDefault();const t=document.getElementById('bt').value.trim();if(!t)return;const r=await api('PUT',BASE+'/drafts/project/bot',{token:t});if(r.ok){alert('Linked: @'+r.bot.bot_username);location.reload();}else alert('Error: '+(r.detail||r.error));}
async function unlinkBot(){if(!confirm('Unlink bot?'))return;const r=await api('DELETE',BASE+'/drafts/project/bot');if(r.ok)location.reload();else alert('Error: '+r.error);}
async function doPromote(){const r=await api('POST',BASE+'/drafts/promote');if(r.ok){alert('Promoted!');location.reload();}else alert('Error: '+(r.detail||r.error));}
</script></body></html>`;
}

function renderAAPPage(project, aap, versions) {
  const base    = _ctx.config.publicBase;
  const sn      = _ctx.config.serverNumber;
  const liveUrl = base+'/'+project.name+'/';
  const aapSecret = aap.token.replace(/^aap_/,'');
  const aapUrl  = base+'/signin/pass_'+sn+'_agent_'+aapSecret;
  const verCount = versions.length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Hub &middot; ${esc(project.name)} &middot; contributor</title>${signinCSS()}</head><body><div class="wrap">
<div class="ey">HUB &middot; ${esc(project.name.toUpperCase())} &middot; AAP</div>
<h1>${esc(aap.name||aap.id)}</h1>
<p class="lead">Contributor on <a href="${liveUrl}" target="_blank">${esc(project.name)}</a> &middot; branch: <code>${esc(aap.branch)}</code></p>
<div class="div"></div>
<div class="sec"><h2>Build loop</h2><pre>POST /drafts/upload  {filename, content}\nPOST /drafts/commit  {message}</pre></div>
<div class="div"></div>
<div class="sec"><h2>This link</h2><p>Your contributor pass (AAP):</p><code>${esc(aapUrl)}</code></div>

<div class="how-to">
  <div class="how-to-title">How to use this link</div>
  <ol class="how-to-steps">
    <li>Open Chrome</li>
    <li>Launch the Claude for Chrome extension</li>
    <li>Drop this link into the chat</li>
  </ol>
  <div class="how-to-note">Claude will take it from there.</div>
</div><footer><div>hub v0.2 &middot; AAP &middot; ${esc(project.name)}</div><div><a href="${liveUrl}" target="_blank">live</a></div></footer>
</div></body></html>`;
}


export function mountProjectMiddleware(app, ctx) {
  const { hasRoutesJs }   = require_runtime(ctx);
  const { tryDispatchHttp } = require_runtime(ctx);

  function isProjectName(slug) {
    if (!slug || isReservedName(slug)) return false;
    if (!/^[a-z0-9_-]{1,40}$/.test(slug)) return false;
    return !!findProjectByName(slug);
  }

  app.use(async (req, res, next) => {
    const isRead  = req.method === 'GET' || req.method === 'HEAD';
    const isWrite = ['POST','PUT','DELETE','PATCH'].includes(req.method);
    if (!isRead && !isWrite) return next();

    const url = req.path;
    if (url.startsWith('/drafts/') || url.startsWith('/signin/') || url.startsWith('/health')) return next();

    const m = url.match(/^\/([a-z0-9_-]+)(\/.*)?$/);
    if (!m) return next();
    const name = m[1];
    const rest = m[2] || '';
    if (!isProjectName(name)) return next();
    if (rest === '' && isRead) return res.redirect(301, `/${name}/`);

    const pp = projectPaths(name);

    // Version snapshots — read-only
    const vm = rest.match(/^\/v\/(\d+)(\/.*)?$/);
    if (vm) {
      if (!isRead) return res.status(405).type('text/plain').send('version snapshots are read-only');
      const N      = vm[1];
      const sub    = vm[2];
      const vDir   = path.join(pp.versions, N);
      if (!fs.existsSync(vDir)) return res.status(404).type('text/plain').send('version not found');
      if (sub === undefined) return res.redirect(301, `/${name}/v/${N}/`);
      return serveStatic(vDir, sub.replace(/^\/+/, ''), res);
    }

    // routes.js dispatch
    if (ctx.modules.runtime?.hasRoutesJs(name)) {
      try {
        const fullUrl  = `${ctx.config.publicBase}${req.originalUrl || req.url}`;
        const pathname = '/' + rest.replace(/^\/+/, '');
        const out      = await ctx.modules.runtime.tryDispatchHttp({ projectName: name, expressReq: req, fullUrl, pathname, method: req.method });
        if (out?.matched) {
          for (const [k, v] of Object.entries(out.headers || {})) res.set(k, v);
          if (!res.get('cache-control')) res.set('Cache-Control', 'no-store');
          return res.status(out.status).send(out.body);
        }
      } catch (e) {
        ctx.logger.error('[static] routes dispatch error on', name, req.method, url + ':', e.message);
        return res.status(500).type('text/plain').send('internal error in routes dispatcher');
      }
    }

    if (!isRead) return res.status(405).type('text/plain').send('method not allowed');

    // Hub fallback landing
    const isRoot   = rest === '' || rest === '/';
    const hasLive  = fs.existsSync(pp.live);
    const hasIndex = hasLive && fs.existsSync(path.join(pp.live, 'index.html'));
    if (isRoot && !hasIndex) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'public, max-age=120');
      return res.send(renderProjectLanding(name, ctx.config.publicBase));
    }
    if (!hasLive) return res.status(404).type('text/plain').send('not yet promoted');
    return serveStatic(pp.live, rest.replace(/^\/+/, ''), res);
  });
}

function require_runtime(ctx) {
  return {
    hasRoutesJs:    (n) => ctx.modules.runtime?.hasRoutesJs(n)    ?? false,
    tryDispatchHttp: (...a) => ctx.modules.runtime?.tryDispatchHttp(...a) ?? { matched: false },
  };
}
