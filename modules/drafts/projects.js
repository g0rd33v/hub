// modules/drafts/projects.js — state.json management + project helpers
// Lifted from drafts/drafts.js (state, findProject*, createProject, createAAP, paths).

import fs   from 'fs';
import fsp  from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import simpleGit from 'simple-git';

const RESERVED_NAMES = new Set([
  'drafts','live','api','pass','v','version','versions',
  'health','whoami','projects','aaps','aap','pap','sap','tbp',
  'static','assets','admin','www','_','config','github',
  'upload','commit','promote','rollback','pending','merge',
  'files','file','history','about','gallery','docs','telepath','hub',
]);

const newToken = (prefix) => prefix + '_' + crypto.randomBytes({ sap:8, pap:6, aap:5 }[prefix] || 6).toString('hex');
const newId    = () => crypto.randomBytes(4).toString('hex');
export const now = () => new Date().toISOString();

let _ctx;
let state = { projects: [] };

export async function init(ctx) {
  _ctx = ctx;
  loadState();
  migrateState();
}

export function getState()  { return state; }
export function saveState() {
  const p = _ctx.paths.state();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function loadState() {
  const p = _ctx.paths.state();
  // Also check legacy path
  const legacyPath = path.join('/var/lib/drafts', '.state.json');
  const candidates = [p, legacyPath];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        state = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (!state.projects) state.projects = [];
        return;
      }
    } catch (e) { _ctx?.logger.error('[drafts/state] load failed:', e.message); }
  }
  state = { projects: [] };
}

function migrateState() {
  let changed = 0;
  for (const p of state.projects) {
    if (p.bot?.token) {
      if (!('webhook_url' in p.bot)) { p.bot.webhook_url = null; changed++; }
      if (!Array.isArray(p.bot.webhook_log)) { p.bot.webhook_log = []; changed++; }
    }
    if (!('github_autosync' in p)) { p.github_autosync = false; changed++; }
  }
  if (!state.last_known_version) { state.last_known_version = '0.2.0'; changed++; }
  if (changed) saveState();
}

export function sanitizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
}
export function isReservedName(n) { return RESERVED_NAMES.has(n); }
export function findProjectByName(name) { return state.projects.find(p => p.name === name) || null; }

// Project paths — v0.2 layout: /var/lib/hub/projects/<name>/
export function projectPaths(name) {
  const root = path.join(_ctx.config.dataDir, 'projects', name);
  return {
    root,
    drafts:   path.join(root, 'drafts'),
    live:     path.join(root, 'live'),
    versions: path.join(root, 'versions'),
  };
}

export async function ensureProjectDirs(name) {
  const pp = projectPaths(name);
  await fsp.mkdir(pp.drafts,   { recursive: true });
  await fsp.mkdir(pp.live,     { recursive: true });
  await fsp.mkdir(pp.versions, { recursive: true });
  const git = simpleGit(pp.drafts);
  if (!fs.existsSync(path.join(pp.drafts, '.git'))) {
    await git.init();
    const hostname = new URL(_ctx.config.publicBase).hostname;
    await git.addConfig('user.email', `hub@${hostname}`, false, 'local');
    await git.addConfig('user.name',  'hub',             false, 'local');
    const readme = path.join(pp.drafts, '.hub-init');
    await fsp.writeFile(readme, 'initialised ' + now() + '\n');
    await git.add('.hub-init');
    await git.commit('init ' + name, { '--allow-empty': null });
    try { await git.branch(['-m', 'main']); } catch {}
  }
  return pp;
}

export async function switchToBranch(git, branch) {
  const branches = await git.branch();
  if (branches.all.includes(branch)) await git.checkout(branch);
  else { try { await git.checkout('main'); } catch {} await git.checkoutLocalBranch(branch); }
}

export async function createProject({ name, description = '', github_repo = null, pap_name = null }) {
  name = sanitizeName(name);
  if (!name) throw new Error('invalid_name');
  if (isReservedName(name)) throw new Error('reserved_name');
  if (findProjectByName(name)) throw new Error('exists');
  const pap  = { id: newId(), token: newToken('pap'), name: pap_name, created_at: now(), revoked: false };
  const proj = { name, description, github_repo, github_autosync: false, created_at: now(), pap, aaps: [] };
  state.projects.push(proj);
  saveState();
  await ensureProjectDirs(name);
  const papSecret = pap.token.replace(/^pap_/, '');
  return {
    project:            name,
    pap_token:          pap.token,
    pap_activation_url: `${_ctx.config.publicBase}/signin/pass_${_ctx.config.serverNumber}_project_${papSecret}`,
    live_url:           `${_ctx.config.publicBase}/${name}/`,
    raw: proj,
  };
}

export async function createAAP(project, { name = null }) {
  const aap = { id: newId(), token: newToken('aap'), name: (name||'').toString().slice(0,60)||null, created_at: now(), revoked: false, branch: '' };
  aap.branch = `aap/${aap.id}`;
  project.aaps = project.aaps || [];
  project.aaps.push(aap);
  saveState();
  const aapSecret = aap.token.replace(/^aap_/, '');
  return {
    aap: { id: aap.id, name: aap.name, branch: aap.branch, created_at: aap.created_at, token: aap.token },
    activation_url: `${_ctx.config.publicBase}/signin/pass_${_ctx.config.serverNumber}_agent_${aapSecret}`,
  };
}

export { newToken, newId };
