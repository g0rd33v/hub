// modules/runtime/cron.js — cron.json executor
// Reads cron.json from project live dir, parses cron expressions,
// and calls dispatchCron(project, handlerName) on schedule.
//
// Supported cron format: 5-field (min hour dom mon dow)
// Special: "* * * * *" = every minute
//          "0 9 * * *" = daily at 09:00 UTC

import fs   from 'fs';
import path from 'path';
import { dispatchCron } from './bots.js';

const timers = new Map(); // projectName -> [intervalId, ...]

let _ctx;
export function init(ctx) { _ctx = ctx; }

function parseCronToMs(expr) {
  // Only handles the two patterns we actually use:
  // "* * * * *"   -> every 60s
  // "N H * * *"   -> daily at H:N UTC
  // Returns { type: 'interval', ms } or { type: 'daily', hour, minute }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (min === '*' && hour === '*') return { type: 'interval', ms: 60 * 1000 };
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*')
    return { type: 'daily', hour: Number(hour), minute: Number(min) };
  return null;
}

function msUntilNext(hour, minute) {
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function loadCronJson(projectName, dataDir) {
  const p = path.join(dataDir, 'projects', projectName, 'live', 'cron.json');
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(e => e.schedule && e.handler);
  } catch { return []; }
}

export function startCronForProject(project) {
  stopCronForProject(project.name);
  const entries = loadCronJson(project.name, _ctx.config.dataDir);
  if (!entries.length) return;

  const ids = [];
  for (const entry of entries) {
    const parsed = parseCronToMs(entry.schedule);
    if (!parsed) continue;
    const log = _ctx.logger.child(`cron:${project.name}`);

    if (parsed.type === 'interval') {
      const id = setInterval(() => {
        dispatchCron(project, entry.handler)
          .catch(e => log.error(entry.handler, 'threw:', e.message));
      }, parsed.ms);
      ids.push(id);
      log.info(`scheduled ${entry.handler} every ${parsed.ms / 1000}s`);
    } else {
      // daily: fire once at next occurrence, then every 24h
      const fire = () => {
        dispatchCron(project, entry.handler)
          .catch(e => log.error(entry.handler, 'threw:', e.message));
        const id = setInterval(fire_interval, 24 * 3600 * 1000);
        ids.push(id);
      };
      const fire_interval = () => {
        dispatchCron(project, entry.handler)
          .catch(e => log.error(entry.handler, 'threw:', e.message));
      };
      const delay = msUntilNext(parsed.hour, parsed.minute);
      const tid = setTimeout(fire, delay);
      ids.push(tid);
      log.info(`scheduled ${entry.handler} daily at ${parsed.hour.toString().padStart(2,'0')}:${parsed.minute.toString().padStart(2,'0')} UTC (in ${Math.round(delay/60000)}m)`);
    }
  }
  timers.set(project.name, ids);
}

export function stopCronForProject(name) {
  const ids = timers.get(name) || [];
  for (const id of ids) { clearInterval(id); clearTimeout(id); }
  timers.delete(name);
}

export function getCronStatus() {
  const out = {};
  for (const [name, ids] of timers) out[name] = ids.length;
  return out;
}
