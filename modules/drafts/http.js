// modules/drafts/http.js — /drafts/* admin API
// Lifted from drafts/drafts.js. All endpoints preserved, updated to use
// modular imports instead of monolith-local functions.

import fs   from 'fs';
import fsp  from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import simpleGit from 'simple-git';

import {
  getState as _getState, saveState as _saveState, findProjectByName, sanitizeName, isReservedName,
  projectPaths, ensureProjectDirs, switchToBranch, createProject, createAAP, now,
  init as projectsInit,
} from './projects.js';
import {
  materializeVersion, promoteToLive, listVersions, githubSyncProject,
} from './git.js';

const VERSION = '0.2.0';

let _ctx;
let _auth;

export async function init(ctx) {
  _ctx = ctx;
  await projectsInit(ctx);
}

function auth() {
  if (!_auth) {
    const { makeAuthMiddleware } = await_creds();
    _auth = makeAuthMiddleware(_ctx);
  }
  return _auth;
}

function await_creds() {
  // credentials.js is synchronous; dynamic import here to avoid circular dep at module load time.
  // We use a lazy singleton pattern.
  let _mod;
  return {
    makeAuthMiddleware: (...a) => {
      if (!_mod) {
        // Inline require-style lazy load. safe because by the time routes are mounted, all modules are ready.
        const { makeAuthMiddleware } = require('../../hub/credentials.js');
        _mod = { makeAuthMiddleware };
      }
      return _mod.makeAuthMiddleware(...a);
    }
  };
}

// Lazy-init auth: pull from ctx.modules once all modules are loaded.
// This avoids the circular: credentials needs drafts, drafts needs credentials.
// Solution: auth middleware calls into ctx.modules.drafts at runtime (not at import time).
import { makeAuthMiddleware } from '../../hub/credentials.js';
let _authObj = null;
function getAuth() {
  if (!_authObj) _authObj = makeAuthMiddleware(_ctx);
  return _authObj;
}
const lazy = (fn) => (req, res, next) => getAuth()[fn](req, res, next);
const authSAP      = lazy('authSAP');
const authPAPorSAP = lazy('authPAPorSAP');
const authAny      = lazy('authAny');

export function mountRoutes(app, ctx) {

  // Health
  app.get('/drafts/health', (req, res) => {
    const tp = _ctx.modules.telegram?.getTelegramStatus?.() || { installed: false };
    const st = getState();
    res.json({
      ok: true, version: VERSION, protocol: 'hub', server_number: ctx.config.serverNumber,
      telegram_available: !!_ctx.modules.telegram,
      runtime_capability: !!_ctx.modules.runtime,
      routes_capability:  !!_ctx.modules.runtime,
      project_bots_capability: !!_ctx.modules.telegram,
      telepath: tp,
      project_bots: {
        total:             st.projects.filter(p => p.bot?.token).length,
        in_webhook_mode:   st.projects.filter(p => p.bot?.token && p.bot?.webhook_url).length,
        analytics_enabled: st.projects.filter(p => p.bot?.token && p.bot?.analytics_enabled !== false).length,
      },
      github_autosync_enabled: st.projects.filter(p => p.github_autosync).length,
      uptime_sec: Math.floor(process.uptime()),
    });
  });

  // Whoami
  app.get('/drafts/whoami', authAny, (req, res) => {
    if (req.tier === 'sap') return res.json({ ok: true, tier: 'sap', total_projects: getState().projects.length });
    if (req.tier === 'pap') return res.json({ ok: true, tier: 'pap', project: req.project.name });
    return res.json({ ok: true, tier: 'aap', project: req.project.name, agent: req.aap.name||'unnamed', branch: req.aap.branch });
  });

  // Server stats
  app.get('/drafts/server/stats', authSAP, (req, res) => {
    const st = getState();
    res.json({
      ok: true, server_number: ctx.config.serverNumber, total_projects: st.projects.length,
      github_default_configured: !!(st.github_default?.token),
      telepath: _ctx.modules.telegram?.getTelegramStatus?.() || {},
      projects: st.projects.map(p => ({
        name: p.name, created_at: p.created_at,
        aap_count: (p.aaps||[]).filter(a=>!a.revoked).length,
        bot_attached: !!(p.bot?.token),
        bot_mode: p.bot?.token ? (p.bot.webhook_url?'webhook':'default') : null,
        github_autosync: !!p.github_autosync,
      })),
    });
  });

  // Projects list
  app.get('/drafts/projects', authSAP, (req, res) => {
    const st = getState();
    const sn = ctx.config.serverNumber;
    const base = ctx.config.publicBase;
    res.json({ ok: true, projects: st.projects.map(p => ({
      name: p.name, description: p.description, github_repo: p.github_repo, github_autosync: !!p.github_autosync,
      created_at: p.created_at, live_url: `${base}/${p.name}/`,
      pap: p.pap ? { id: p.pap.id, revoked: p.pap.revoked, activation_url: `${base}/signin/pass_${sn}_project_${p.pap.token.replace(/^pap_/,'')}` } : null,
      aaps: (p.aaps||[]).map(a => ({ id: a.id, name: a.name, revoked: a.revoked })),
    }))});
  });

  // Create project
  app.post('/drafts/projects', authSAP, async (req, res) => {
    try {
      const out = await createProject({ name: req.body.name, description: req.body.description||'', github_repo: req.body.github_repo||null, pap_name: req.body.pap_name||null });
      try { _ctx.modules.telegram?.hooks?.onNewProject(out.raw); } catch {}
      res.json({ ok: true, project: out.project, pap_activation_url: out.pap_activation_url, live_url: out.live_url });
    } catch (e) {
      const code = ['invalid_name','reserved_name'].includes(e.message) ? 400 : e.message === 'exists' ? 409 : 500;
      res.status(code).json({ ok: false, error: e.message });
    }
  });

  // Delete project
  app.delete('/drafts/projects/:name', authSAP, async (req, res) => {
    const name = sanitizeName(req.params.name);
    const p    = findProjectByName(name);
    if (!p) return res.status(404).json({ ok: false, error: 'not_found' });
    const st = getState();
    st.projects = st.projects.filter(x => x.name !== name);
    saveState();
    try { execSync(`rm -rf "${projectPaths(name).root}"`); } catch {}
    res.json({ ok: true, deleted: name });
  });

  // Project info
  app.get('/drafts/project/info', authAny, (req, res) => {
    const p = req.project;
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    res.json({ ok: true, project: p.name, description: p.description, github_repo: p.github_repo, github_autosync: !!p.github_autosync,
      created_at: p.created_at, live_url: `${ctx.config.publicBase}/${p.name}/`, viewer_tier: req.tier,
      bot_attached: !!(p.bot?.token), bot_username: p.bot?.bot_username||null,
      bot_mode: p.bot?.token ? (p.bot.webhook_url?'webhook':'default') : null });
  });

  // Upload
  app.post('/drafts/upload', authAny, async (req, res) => {
    const p = req.project;
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const filename = String(req.body.filename||'').replace(/^\/+/,'').replace(/\.\./g,'');
    if (!filename) return res.status(400).json({ ok: false, error: 'filename_required' });
    const where  = req.body.where === 'live' && req.tier !== 'aap' ? 'live' : 'drafts';
    const pp     = await ensureProjectDirs(p.name);
    const root   = where === 'live' ? pp.live : pp.drafts;
    const git    = simpleGit(pp.drafts);
    if (req.tier === 'aap') await switchToBranch(git, req.aap.branch);
    else await switchToBranch(git, 'main');
    const full = path.join(root, filename);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    if (req.body.content_b64) await fsp.writeFile(full, Buffer.from(req.body.content_b64, 'base64'));
    else await fsp.writeFile(full, req.body.content||'');
    res.json({ ok: true, path: filename, where, branch: req.tier === 'aap' ? req.aap.branch : (where === 'drafts' ? 'main' : null) });
  });

  // Commit
  app.post('/drafts/commit', authAny, async (req, res) => {
    const p = req.project;
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const pp     = await ensureProjectDirs(p.name);
    const git    = simpleGit(pp.drafts);
    const branch = req.tier === 'aap' ? req.aap.branch : 'main';
    await switchToBranch(git, branch);
    await git.add('.');
    try {
      const msg = (req.body.message||'update').toString().slice(0,200);
      const out = await git.commit(msg);
      let versionInfo = null;
      if (branch === 'main' && out.commit) {
        const N    = await materializeVersion(p.name);
        versionInfo = { n: N, url: `${ctx.config.publicBase}/${p.name}/v/${N}/` };
        try { _ctx.modules.telegram?.hooks?.onMainCommit(p, { commit: out.commit, summary: out.summary, message: msg }, N); } catch {}
        if (p.github_autosync && p.github_repo) githubSyncProject(p).catch(e => ctx.logger.error('[autosync after commit] failed:', e.message));
      }
      res.json({ ok: true, branch, commit: out.commit, summary: out.summary, version: versionInfo });
    } catch (e) { res.status(500).json({ ok: false, error: 'commit_failed', detail: e.message }); }
  });

  // Promote
  app.post('/drafts/promote', authPAPorSAP, async (req, res) => {
    const p = req.project || findProjectByName(sanitizeName(req.body.project||''));
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const pp  = await ensureProjectDirs(p.name);
    const git = simpleGit(pp.drafts);
    try { await switchToBranch(git, 'main'); await promoteToLive(p.name); res.json({ ok: true, live_url: `${ctx.config.publicBase}/${p.name}/` }); }
    catch (e) { res.status(500).json({ ok: false, error: 'promote_failed', detail: e.message }); }
  });

  // Files list
  app.get('/drafts/files', authAny, async (req, res) => {
    const p     = req.project;
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const where = req.query.where === 'live' ? 'live' : 'drafts';
    const pp    = await ensureProjectDirs(p.name);
    const root  = where === 'live' ? pp.live : pp.drafts;
    if (where === 'drafts' && req.tier === 'aap') { const g = simpleGit(pp.drafts); try { await switchToBranch(g, req.aap.branch); } catch {} }
    const walk = (dir, base='') => { const out=[]; if (!fs.existsSync(dir)) return out; for (const e of fs.readdirSync(dir,{withFileTypes:true})) { if (e.name.startsWith('.')) continue; const rel=path.posix.join(base,e.name); const abs=path.join(dir,e.name); if (e.isDirectory()) out.push(...walk(abs,rel)); else { const st=fs.statSync(abs); out.push({name:rel,size:st.size,mtime:st.mtime.toISOString()}); } } return out; };
    res.json({ ok: true, where, files: walk(root) });
  });

  // Versions
  app.get('/drafts/project/versions', authAny, async (req, res) => {
    const p = req.project;
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const pp       = await ensureProjectDirs(p.name);
    const versions = await listVersions(p.name);
    let hashes = [];
    try { hashes = execSync(`git -C "${pp.drafts}" rev-list main --reverse`).toString().trim().split('\n').filter(Boolean); } catch {}
    const out = [];
    for (const N of versions) {
      const hash = hashes[N]; let msg = null, date = null;
      if (hash) { try { const line = execSync(`git -C "${pp.drafts}" show -s --format="%s|%aI" ${hash}`).toString().trim(); [msg, date] = line.split('|'); } catch {} }
      out.push({ n: N, url: `${ctx.config.publicBase}/${p.name}/v/${N}/`, hash: hash?hash.slice(0,7):null, message: msg, date });
    }
    res.json({ ok: true, project: p.name, versions: out });
  });

  // History
  app.get('/drafts/history', authAny, async (req, res) => {
    const p = req.project;
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const pp     = await ensureProjectDirs(p.name);
    const git    = simpleGit(pp.drafts);
    const branch = req.tier === 'aap' ? req.aap.branch : 'main';
    try { await switchToBranch(git, branch); } catch {}
    const limit = Math.min(Number(req.query.limit)||20, 100);
    const log   = await git.log({ maxCount: limit });
    res.json({ ok: true, branch, commits: log.all.map(c => ({ hash: c.hash.slice(0,7), full: c.hash, date: c.date, message: c.message })) });
  });

  // AAPs
  app.post('/drafts/aaps', authPAPorSAP, async (req, res) => {
    const p = req.project || findProjectByName(sanitizeName(req.body.project||''));
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const out = await createAAP(p, { name: req.body.name });
    res.json({ ok: true, aap: out.aap, activation_url: out.activation_url });
  });

  app.get('/drafts/aaps', authPAPorSAP, async (req, res) => {
    const p = req.project || findProjectByName(sanitizeName(req.query.project||''));
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const pp      = await ensureProjectDirs(p.name);
    const git     = simpleGit(pp.drafts);
    const branches = (await git.branch()).all;
    const sn       = ctx.config.serverNumber;
    const base     = ctx.config.publicBase;
    const aaps = await Promise.all((p.aaps||[]).map(async a => {
      const br = `aap/${a.id}`; let pending = 0;
      if (branches.includes(br)) { try { const log = await git.log({ from: 'main', to: br }); pending = log.total; } catch {} }
      const aapSecret = a.token.replace(/^aap_/,'');
      return { id: a.id, name: a.name, branch: br, revoked: a.revoked, created_at: a.created_at, activation_url: `${base}/signin/pass_${sn}_agent_${aapSecret}`, pending_commits: pending };
    }));
    res.json({ ok: true, project: p.name, aaps });
  });

  app.delete('/drafts/aaps/:id', authPAPorSAP, (req, res) => {
    const p = req.project || findProjectByName(sanitizeName(req.query.project||''));
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const a = (p.aaps||[]).find(x => x.id === req.params.id);
    if (!a) return res.status(404).json({ ok: false, error: 'not_found' });
    a.revoked = true; saveState();
    res.json({ ok: true, revoked: a.id });
  });

  // Merge
  app.post('/drafts/merge', authPAPorSAP, async (req, res) => {
    const p = req.project || findProjectByName(sanitizeName(req.body.project||''));
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const aapId = req.body.aap_id;
    if (!aapId) return res.status(400).json({ ok: false, error: 'aap_id_required' });
    const aap = (p.aaps||[]).find(x => x.id === aapId);
    if (!aap) return res.status(404).json({ ok: false, error: 'aap_not_found' });
    const pp  = await ensureProjectDirs(p.name);
    const git = simpleGit(pp.drafts);
    try {
      await git.checkout('main');
      await git.merge([`aap/${aap.id}`, '--no-ff', '-m', `merge aap/${aap.name||aap.id}`]);
      const N = await materializeVersion(p.name);
      try { _ctx.modules.telegram?.hooks?.onAAPMerged(p, aap, N); } catch {}
      if (p.github_autosync && p.github_repo) githubSyncProject(p).catch(e => ctx.logger.error('[autosync after merge] failed:', e.message));
      res.json({ ok: true, merged: aap.id, branch: `aap/${aap.id}`, version: N, version_url: `${ctx.config.publicBase}/${p.name}/v/${N}/` });
    } catch (e) { res.status(500).json({ ok: false, error: 'merge_failed', detail: e.message }); }
  });

  // Pending
  app.get('/drafts/pending', authPAPorSAP, async (req, res) => {
    const p = req.project || findProjectByName(sanitizeName(req.query.project||''));
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const pp       = await ensureProjectDirs(p.name);
    const git      = simpleGit(pp.drafts);
    const branches = (await git.branch()).all.filter(b => b.startsWith('aap/'));
    const result   = [];
    for (const br of branches) {
      const aapId = br.slice(4);
      const aap   = (p.aaps||[]).find(x => x.id === aapId);
      if (!aap || aap.revoked) continue;
      try { const log = await git.log({ from: 'main', to: br }); if (log.total === 0) continue; result.push({ aap_id: aap.id, aap_name: aap.name, branch: br, commits: log.all.slice(0,20).map(c=>({hash:c.hash.slice(0,7),message:c.message,date:c.date})), total_pending: log.total }); } catch {}
    }
    res.json({ ok: true, project: p.name, pending: result });
  });

  // Rollback
  app.post('/drafts/rollback', authPAPorSAP, async (req, res) => {
    const p = req.project || findProjectByName(sanitizeName(req.body.project||''));
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    const target = String(req.body.commit_or_version||req.body.commit||req.body.version||'');
    if (!target) return res.status(400).json({ ok: false, error: 'commit_or_version_required' });
    const pp  = await ensureProjectDirs(p.name);
    const git = simpleGit(pp.drafts);
    try {
      await switchToBranch(git, 'main');
      let commitHash = target;
      if (/^\d+$/.test(target)) {
        const N = Number(target);
        const all = execSync(`git -C "${pp.drafts}" rev-list main --reverse`).toString().trim().split('\n');
        const c = all[N]; if (!c) return res.status(404).json({ ok: false, error: 'version_not_found' });
        commitHash = c;
      }
      await git.reset(['--hard', commitHash]);
      try { await git.commit(`rollback to ${target}`, { '--allow-empty': null }); } catch {}
      const total = Number(execSync(`git -C "${pp.drafts}" rev-list --count main`).toString().trim());
      const newN  = Math.max(1, total-1);
      try { execSync(`rm -rf "${path.join(pp.versions, String(newN))}"`); } catch {}
      if (fs.existsSync(pp.versions)) { for (const dir of fs.readdirSync(pp.versions)) { if (/^\d+$/.test(dir) && Number(dir) > newN) try { execSync(`rm -rf "${path.join(pp.versions, dir)}"`); } catch {} } }
      const N = await materializeVersion(p.name);
      res.json({ ok: true, reset_to: commitHash, new_version: N, version_url: `${ctx.config.publicBase}/${p.name}/v/${N}/` });
    } catch (e) { res.status(500).json({ ok: false, error: 'rollback_failed', detail: e.message }); }
  });

  // GitHub config endpoints
  app.get('/drafts/config/github', authSAP, (req, res) => { const cfg = getState().github_default; if (!cfg?.token) return res.json({ ok: true, configured: false }); res.json({ ok: true, configured: true, user: cfg.user, token_preview: cfg.token.slice(0,4)+'...'+cfg.token.slice(-4) }); });
  app.put('/drafts/config/github', authSAP, (req, res) => { const user = String(req.body.user||'').trim(); const token = String(req.body.token||'').trim(); if (!user||!token) return res.status(400).json({ ok: false, error: 'user_and_token_required' }); getState().github_default = { user, token }; saveState(); res.json({ ok: true, configured: true, user }); });
  app.delete('/drafts/config/github', authSAP, (req, res) => { delete getState().github_default; saveState(); res.json({ ok: true, configured: false }); });

  // GitHub sync
  app.post('/drafts/github/sync', authPAPorSAP, async (req, res) => {
    const p = req.project || findProjectByName(sanitizeName(req.body.project||''));
    if (!p) return res.status(400).json({ ok: false, error: 'no_project_context' });
    try { const out = await githubSyncProject(p); res.json({ ok: true, ...out }); }
    catch (e) { const code = ['project_not_linked_to_github','github_not_configured'].includes(e.message) ? 400 : 500; res.status(code).json({ ok: false, error: e.message }); }
  });

  // Bot management (delegated to telegram module)
  function requireBot(req, res) {
    if (!_ctx.modules.telegram) { res.status(501).json({ ok: false, error: 'telegram_module_unavailable' }); return false; } return true;
  }
  function projOf(req) { return req.project || findProjectByName(sanitizeName(req.query.project||req.body?.project||'')); }

  app.get('/drafts/project/bot', authPAPorSAP, (req, res) => { if (!requireBot(req,res)) return; const p=projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'}); const {getBotStatus} = _ctx.modules.telegram; res.json({ok:true,project:p.name,bot:getBotStatus?.(p)||{}}); });
  app.put('/drafts/project/bot', authPAPorSAP, async (req, res) => { if (!requireBot(req,res)) return; const p=projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'}); const tk=String(req.body.token||'').trim(); if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(tk)) return res.status(400).json({ok:false,error:'invalid_bot_token_format'}); try { const out=await _ctx.modules.telegram.installBot(p,tk,{webhook_url:req.body.webhook_url||null}); res.json({ok:true,project:p.name,bot:out}); } catch(e) { res.status(400).json({ok:false,error:'install_failed',detail:e.message}); } });
  app.delete('/drafts/project/bot', authPAPorSAP, async (req, res) => { if (!requireBot(req,res)) return; const p=projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'}); const out=await _ctx.modules.telegram.unlinkBot(p); res.json({ok:true,project:p.name,...out}); });
  app.post('/drafts/project/bot/broadcast', authPAPorSAP, async (req, res) => { if (!requireBot(req,res)) return; const p=projOf(req); if (!p||!p.bot?.token) return res.status(400).json({ok:false,error:'no_bot_attached'}); if (p.bot.webhook_url) return res.status(400).json({ok:false,error:'broadcast_unavailable_in_webhook_mode'}); const html=String(req.body.html||'').trim(); if (!html) return res.status(400).json({ok:false,error:'html_required'}); const out=await _ctx.modules.telegram.broadcast(p,html); res.json({ok:true,project:p.name,...out}); });

  // Runtime logs
  app.get('/drafts/project/bot/logs', authPAPorSAP, (req, res) => { const p=projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'}); const limit=Math.max(1,Math.min(1000,parseInt(req.query.limit,10)||200)); const data=_ctx.modules.runtime?.getLogs(p.name,limit); res.json({ok:true,project:p.name,...(data||{lines:[],present:false})}); });
  app.delete('/drafts/project/bot/logs', authPAPorSAP, (req, res) => { const p=projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'}); _ctx.modules.runtime?.clearLogs(p.name); res.json({ok:true,cleared:true}); });


  // Bot info (getMe)
  app.get('/drafts/project/bot/info', authPAPorSAP, async (req, res) => {
    if (!requireBot(req,res)) return;
    const p = projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'});
    try {
      const r = await fetch(`https://api.telegram.org/bot${p.bot.token}/getMe`);
      const d = await r.json();
      res.json({ok:true, project:p.name, bot: d.result || null, raw: d});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
  });

  // Bot profile: set name, description, short description
  app.post('/drafts/project/bot/profile', authPAPorSAP, async (req, res) => {
    if (!requireBot(req,res)) return;
    const p = projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'});
    const { name, description, short_description } = req.body;
    const base = `https://api.telegram.org/bot${p.bot.token}`;
    const results = {};
    if (name !== undefined) {
      const r = await fetch(`${base}/setMyName`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:String(name).slice(0,64)})});
      results.name = await r.json();
    }
    if (description !== undefined) {
      const r = await fetch(`${base}/setMyDescription`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:String(description).slice(0,512)})});
      results.description = await r.json();
    }
    if (short_description !== undefined) {
      const r = await fetch(`${base}/setMyShortDescription`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({short_description:String(short_description).slice(0,120)})});
      results.short_description = await r.json();
    }
    res.json({ok:true, project:p.name, results});
  });

  // Bot commands: get and set
  app.get('/drafts/project/bot/commands', authPAPorSAP, async (req, res) => {
    if (!requireBot(req,res)) return;
    const p = projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'});
    try {
      const r = await fetch(`https://api.telegram.org/bot${p.bot.token}/getMyCommands`);
      const d = await r.json();
      res.json({ok:true, project:p.name, commands: d.result || []});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
  });

  app.post('/drafts/project/bot/commands', authPAPorSAP, async (req, res) => {
    if (!requireBot(req,res)) return;
    const p = projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'});
    const commands = req.body.commands;
    if (!Array.isArray(commands)) return res.status(400).json({ok:false,error:'commands must be array'});
    try {
      const r = await fetch(`https://api.telegram.org/bot${p.bot.token}/setMyCommands`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({commands: commands.slice(0,100).map(c=>({command:String(c.command||'').slice(1,32).toLowerCase().replace(/[^a-z0-9_]/g,''), description:String(c.description||'').slice(0,256)}))})
      });
      const d = await r.json();
      res.json({ok:true, project:p.name, result:d});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
  });

  // Webhook info
  app.get('/drafts/project/bot/webhook', authPAPorSAP, async (req, res) => {
    if (!requireBot(req,res)) return;
    const p = projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'});
    try {
      const r = await fetch(`https://api.telegram.org/bot${p.bot.token}/getWebhookInfo`);
      const d = await r.json();
      res.json({ok:true, project:p.name, webhook: d.result || null});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
  });

  // Delete webhook (switch to polling)
  app.delete('/drafts/project/bot/webhook', authPAPorSAP, async (req, res) => {
    if (!requireBot(req,res)) return;
    const p = projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'});
    try {
      const r = await fetch(`https://api.telegram.org/bot${p.bot.token}/deleteWebhook`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({drop_pending_updates:false})
      });
      const d = await r.json();
      p.bot.webhook_url = null; saveState();
      res.json({ok:true, project:p.name, result:d});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
  });

  // Direct message to specific user
  app.post('/drafts/project/bot/send', authPAPorSAP, async (req, res) => {
    if (!requireBot(req,res)) return;
    const p = projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'});
    const { chat_id, text, parse_mode } = req.body;
    if (!chat_id || !text) return res.status(400).json({ok:false,error:'chat_id and text required'});
    try {
      const r = await fetch(`https://api.telegram.org/bot${p.bot.token}/sendMessage`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({chat_id, text:String(text).slice(0,4096), parse_mode:parse_mode||'HTML', disable_web_page_preview:true})
      });
      const d = await r.json();
      res.json({ok:d.ok, project:p.name, result:d.result||null, description:d.description||null});
    } catch(e) { res.status(500).json({ok:false,error:e.message}); }
  });


  // Routes.js status
  app.get('/drafts/project/routes', authPAPorSAP, (req, res) => { const p=projOf(req); if (!p) return res.status(400).json({ok:false,error:'no_project_context'}); res.json({ok:true,project:p.name,routes:_ctx.modules.runtime?.getRoutesStatus?.(p.name)||{present:false}}); });

}

// Re-export so ctx.modules.drafts.getState() etc work
export function getState() { return _getState(); }
export function saveState() { return _saveState(); }
export function findProjectByPAP(token) {
  return getState().projects.find(p => p.pap && p.pap.token === token) || null;
}
export function findProjectAndAAPByAAPToken(token) {
  for (const p of getState().projects) {
    const a = (p.aaps||[]).find(a => a.token === token && !a.revoked);
    if (a) return { project: p, aap: a };
  }
  return null;
}
