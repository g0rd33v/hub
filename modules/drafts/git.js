// modules/drafts/git.js — git operations (commit, promote, snapshot, rollback)
// Lifted from drafts/drafts.js.

import fs   from 'fs';
import fsp  from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import simpleGit from 'simple-git';
import { projectPaths, switchToBranch, ensureProjectDirs, findProjectByName } from './projects.js';

let _ctx;
export function init(ctx) { _ctx = ctx; }

export async function materializeVersion(name) {
  const pp = projectPaths(name);
  let total;
  try { total = Number(execSync(`git -C "${pp.drafts}" rev-list --count main`).toString().trim()); } catch { return null; }
  const N    = Math.max(1, total - 1);
  const dest = path.join(pp.versions, String(N));
  if (fs.existsSync(dest)) return N;
  const tmp = dest + '.tmp';
  try { execSync(`rm -rf "${tmp}"`); } catch {}
  await fsp.mkdir(pp.versions, { recursive: true });
  execSync(`cp -a "${pp.drafts}/." "${tmp}"`);
  try { execSync(`rm -rf "${tmp}/.git" "${tmp}/.hub-init"`); } catch {}
  execSync(`mv "${tmp}" "${dest}"`);
  return N;
}

export async function promoteToLive(name) {
  const pp  = projectPaths(name);
  const tmp = pp.live + '.tmp';
  const old = pp.live + '.old';
  try { execSync(`rm -rf "${tmp}" "${old}"`); } catch {}
  execSync(`cp -a "${pp.drafts}/." "${tmp}"`);
  try { execSync(`rm -rf "${tmp}/.git" "${tmp}/.hub-init"`); } catch {}
  try { execSync(`mv "${pp.live}" "${old}"`); } catch {}
  execSync(`mv "${tmp}" "${pp.live}"`);
  try { execSync(`rm -rf "${old}"`); } catch {}
}

export async function listVersions(name) {
  const pp = projectPaths(name);
  if (!fs.existsSync(pp.versions)) return [];
  return fs.readdirSync(pp.versions, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
    .map(d => Number(d.name))
    .sort((a, b) => a - b);
}

export async function githubSyncProject(project) {
  if (!project.github_repo) throw new Error('project_not_linked_to_github');
  const gh = resolveGithubConfig(project);
  if (!gh) throw new Error('github_not_configured');
  const pp     = await ensureProjectDirs(project.name);
  const git    = simpleGit(pp.drafts);
  await switchToBranch(git, 'main');
  const remote = `https://${gh.user}:${gh.token}@github.com/${project.github_repo}.git`;
  const remotes = await git.getRemotes();
  if (!remotes.find(r => r.name === 'origin')) await git.addRemote('origin', remote);
  else await git.remote(['set-url', 'origin', remote]);
  await git.push(['-u', 'origin', 'main', '--force']);
  await git.remote(['set-url', 'origin', `https://github.com/${project.github_repo}.git`]);
  return { pushed_to: project.github_repo, config_source: gh.source };
}

function resolveGithubConfig(project) {
  const state = _ctx.modules.drafts.getState();
  if (project?.github_config?.token && project?.github_config?.user)
    return { user: project.github_config.user, token: project.github_config.token, source: 'project' };
  if (state.github_default?.token && state.github_default?.user)
    return { user: state.github_default.user, token: state.github_default.token, source: 'server_default' };
  const gu = process.env.GITHUB_USER, gt = process.env.GITHUB_TOKEN;
  if (gu && gt) return { user: gu, token: gt, source: 'env' };
  return null;
}
