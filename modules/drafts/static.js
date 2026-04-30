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
<style>*{box-sizing:border-box;margin:0;padding:0}html,body{background:#000;color:#f5f5f5;font-family:Inter,-apple-system,sans-serif;font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}.wrap{max-width:720px;margin:0 auto;padding:80px 24px 96px}.hero{text-align:center;margin-bottom:80px}.hero .at{font-size:13px;letter-spacing:.18em;color:#555;text-transform:uppercase;font-weight:600;margin-bottom:16px}.hero h1{font-size:56px;font-weight:800;letter-spacing:-.04em;line-height:1;margin-bottom:16px;word-break:break-word}.hero .sub{font-size:14px;color:#888;margin-bottom:32px}.cta{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#000;padding:14px 24px;border-radius:12px;font-weight:700;font-size:14px}.bottom{text-align:center;padding-top:48px;border-top:1px solid rgba(255,255,255,.06)}.bottom .links{display:flex;gap:20px;justify-content:center;margin-bottom:20px}.bottom a{font-size:13px;font-weight:600;color:#f5f5f5;display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border:1px solid rgba(255,255,255,.1);border-radius:9px}.foot{font-size:12px;color:#444}</style>
</head><body><div class="wrap">
<div class="hero"><div class="at">Telegram bot</div><h1>@${bot}</h1><div class="sub">Created and managed with Hub</div>
<a href="${tg}" class="cta"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M21.92 4.27a.75.75 0 0 0-.81-.13L2.65 11.7a.75.75 0 0 0 .04 1.4l4.71 1.7 1.81 5.71a.75.75 0 0 0 1.27.27l2.74-2.95 4.71 3.45a.75.75 0 0 0 1.18-.42l3.05-15.92a.75.75 0 0 0-.24-.67Z"/></svg>Open in Telegram</a></div>
<div class="bottom"><div class="links"><a href="${hubBot}">@LabsHubBot</a><a href="${hub}">hub.labs.co</a></div><div class="foot">@${bot} on Hub</div></div>
</div></body></html>`;
}

// Signin page rendering — delegates to renderPage from drafts.js
// In v0.2 the renderPage function is preserved as-is; it's large but correct.
// Full rewrite deferred to v0.3.
let _ctx;
export function init(ctx) { _ctx = ctx; }

export async function renderSignin(req, res, { tier, token }) {
  const { getSAP } = await import('../../hub/credentials.js');
  if (tier === 'sap') {
    if (token !== getSAP()) return res.status(404).send('not found');
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
  return `<style>*{box-sizing:border-box;margin:0;padding:0}html,body{background:#000;color:#f5f5f5;font-family:Inter,system-ui,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}a{color:#a8a8a8;text-underline-offset:3px}code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;background:rgba(255,255,255,.06);padding:1px 6px;border-radius:4px}.wrap{max-width:720px;margin:0 auto;padding:64px 28px 96px}.ey{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#a8a8a8;margin-bottom:32px}h1{font-size:48px;font-weight:700;letter-spacing:-.035em;line-height:1.05;margin-bottom:20px}.lead{font-size:16px;color:#a8a8a8;margin-bottom:0;max-width:560px}.div{border-top:1px solid rgba(255,255,255,.07);margin:40px 0 28px}.sec h2{font-size:22px;font-weight:700;margin-bottom:14px}.sec p{font-size:14px;color:#a8a8a8;margin-bottom:12px}pre{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:12px 14px;overflow-x:auto;color:#d4d4d4;margin:8px 0}.tbl{width:100%;border-collapse:collapse;font-size:13px}.tbl th{text-align:left;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6a6a6a;padding:8px;border-bottom:1px solid rgba(255,255,255,.07)}.tbl td{padding:12px 8px;border-bottom:1px solid rgba(255,255,255,.04);color:#d4d4d4}.tbl td.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}.tbl a{color:#a8a8a8}footer{margin-top:56px;padding-top:20px;border-top:1px solid rgba(255,255,255,.07);display:flex;justify-content:space-between;font-size:12px;color:#6a6a6a;font-family:ui-monospace,Menlo,monospace}footer a{color:#a8a8a8;text-decoration:none}</style>`;
}

function renderSAPPage() {
  const st    = _ctx.modules.drafts.getState();
  const base  = _ctx.config.publicBase;
  const sn    = _ctx.config.serverNumber;
  const projs = st.projects || [];
  const tpStatus = _ctx.modules.telegram ? 'connected' : 'no telegram module';
  let rows = '';
  for (const p of projs) {
    const papSecret = p.pap?.token?.replace(/^pap_/,'');
    const papUrl    = papSecret ? `${base}/signin/pass_${sn}_project_${papSecret}` : '';
    rows += `<tr><td class="mono">${esc(p.name)}</td><td class="mono">${p.aaps?.filter(a=>!a.revoked).length||0}</td><td>${p.bot?.bot_username?'@'+esc(p.bot.bot_username):''}</td><td><a href="${base}/${esc(p.name)}/" target="_blank">live</a>${papUrl?` · <a href="${esc(papUrl)}">pap</a>`:''}</td></tr>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Hub · Server Root</title>${signinCSS()}</head><body><div class="wrap">
<div class="ey">HUB · SERVER ROOT · SAP</div>
<h1>Root key.</h1>
<p class="lead">Full control over this Hub server. Create projects, manage everything.</p>
<div class="div"></div>
<div class="sec"><h2>Server</h2><p>Number: <code>${sn}</code> · Public base: <code>${esc(base)}</code> · Telegram: ${tpStatus} · Projects: ${projs.length}</p></div>
<div class="div"></div>
<div class="sec"><h2>Projects</h2>
<table class="tbl"><thead><tr><th>Name</th><th>AAPs</th><th>Bot</th><th>Links</th></tr></thead><tbody>${rows}</tbody></table>
<p style="margin-top:14px;font-size:13px;color:#6a6a6a">Create: <code>POST ${base}/drafts/projects</code> with SAP Bearer</p></div>
<div class="div"></div>
<div class="sec"><h2>API</h2><pre>GET  /drafts/projects
POST /drafts/projects  {name, description}
GET  /drafts/server/stats
GET  /health</pre></div>
<footer><div>hub v0.2 · SAP</div><div><a href="${base}/docs">docs</a> · <a href="https://github.com/g0rd33v/hub">github</a></div></footer>
</div></body></html>`;
}

function renderPAPPage(project, versions) {
  const base       = _ctx.config.publicBase;
  const sn         = _ctx.config.serverNumber;
  const liveUrl    = `${base}/${project.name}/`;
  const papSecret  = project.pap?.token?.replace(/^pap_/,'');
  const portable   = papSecret ? `${base}/signin/pass_${sn}_project_${papSecret}` : '';
  const verCount   = versions.length;
  const aapCount   = (project.aaps||[]).filter(a=>!a.revoked).length;
  const botMode    = project.bot?.token ? (project.bot.webhook_url ? 'webhook' : 'default') : 'none';
  let verRows = '';
  for (const N of [...versions].reverse().slice(0,8)) {
    const isLatest = N === versions[versions.length-1];
    verRows += `<tr><td class="mono">v${N}</td><td>${isLatest?'<span style="color:#4ade80">live</span>':'archived'}</td><td><a href="${base}/${esc(project.name)}/v/${N}/" target="_blank">view</a></td></tr>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Hub · ${esc(project.name)}</title>${signinCSS()}</head><body><div class="wrap">
<div class="ey">HUB · ${esc(project.name.toUpperCase())} · PAP</div>
<h1>${esc(project.description||project.name)}</h1>
<p class="lead">Live at <a href="${liveUrl}" target="_blank">${liveUrl}</a> · ${verCount} version${verCount===1?'':'s'} · ${aapCount} contributor${aapCount===1?'':'s'} · bot: ${botMode}</p>
<div class="div"></div>
<div class="sec"><h2>Build loop</h2><pre>POST /drafts/upload  {filename, content}   # upload file
POST /drafts/commit  {message}             # commit to main
POST /drafts/promote                       # publish to live</pre></div>
${verCount?`<div class="div"></div><div class="sec"><h2>Versions</h2><table class="tbl"><thead><tr><th>Ver</th><th>State</th><th>URL</th></tr></thead><tbody>${verRows}</tbody></table></div>`:''}
<div class="div"></div>
<div class="sec"><h2>This link</h2><p>Your project pass (PAP). Bookmark it: <code>${esc(portable)}</code></p><p>Mint contributor passes: <code>POST /drafts/aaps {name}</code></p></div>
<footer><div>hub v0.2 · PAP · ${esc(project.name)}</div><div><a href="${liveUrl}" target="_blank">live</a> · <a href="${base}/docs">docs</a></div></footer>
</div></body></html>`;
}

function renderAAPPage(project, aap, versions) {
  const base    = _ctx.config.publicBase;
  const liveUrl = `${base}/${project.name}/`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Hub · ${esc(project.name)} contributor</title>${signinCSS()}</head><body><div class="wrap">
<div class="ey">HUB · ${esc(project.name.toUpperCase())} · CONTRIBUTOR</div>
<h1>Your branch.</h1>
<p class="lead">Working on <strong>${esc(project.name)}</strong>. Live at <a href="${liveUrl}" target="_blank">${liveUrl}</a>. Branch: <code>${esc(aap.branch)}</code></p>
<div class="div"></div>
<div class="sec"><h2>Contribute</h2><pre>POST /drafts/upload  {filename, content}   # upload to your branch
POST /drafts/commit  {message}             # commit
# owner merges: POST /drafts/merge {aap_id}</pre></div>
<footer><div>hub v0.2 · AAP · ${esc(project.name)}</div><div><a href="${liveUrl}" target="_blank">live</a></div></footer>
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
