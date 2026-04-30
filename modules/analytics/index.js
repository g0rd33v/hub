// modules/analytics/index.js
// Thin wrapper around drafts/analytics.js logic, reorganised as a module.
// All analytics functions lifted verbatim — no logic changes.

import fs   from 'fs';
import path from 'path';

const MAX_USERS_IN_SUMMARY  = 10000;
const MAX_BYTES_BEFORE_ROTATE = 50 * 1024 * 1024;
const SUMMARY_DAILY_KEEP_DAYS = 60;

const LANG_TO_COUNTRY_GUESS = {
  'ru':'RU','uk':'UA','be':'BY','kk':'KZ','ky':'KG','uz':'UZ','tg':'TJ',
  'en':'US','en-us':'US','en-gb':'GB','en-au':'AU','en-ca':'CA','en-in':'IN',
  'es':'ES','es-mx':'MX','es-ar':'AR','pt':'PT','pt-br':'BR',
  'de':'DE','fr':'FR','it':'IT','nl':'NL','pl':'PL','cs':'CZ','sk':'SK',
  'hu':'HU','ro':'RO','bg':'BG','sr':'RS','hr':'HR','sl':'SI','el':'GR',
  'tr':'TR','ar':'SA','fa':'IR','he':'IL','hi':'IN','bn':'BD','ta':'IN',
  'th':'TH','vi':'VN','id':'ID','ms':'MY','tl':'PH','ko':'KR',
  'ja':'JP','zh':'CN','zh-cn':'CN','zh-tw':'TW','zh-hk':'HK',
  'sv':'SE','no':'NO','nb':'NO','da':'DK','fi':'FI','is':'IS','et':'EE',
  'lv':'LV','lt':'LT','ka':'GE','hy':'AM','az':'AZ','mn':'MN',
  'sw':'KE','am':'ET','zu':'ZA','af':'ZA','ca':'ES','eu':'ES','gl':'ES',
};

function guessCountry(langCode) {
  if (!langCode) return null;
  const k = String(langCode).toLowerCase();
  return LANG_TO_COUNTRY_GUESS[k] || LANG_TO_COUNTRY_GUESS[k.split('-')[0]] || null;
}

let _ctx;

function dataDir() { return _ctx.config.dataDir; }
function projectRoot(n) { return path.join(dataDir(), 'projects', n); }
function logPath(n)     { return path.join(projectRoot(n), '.analytics.jsonl'); }
function summaryPath(n) { return path.join(projectRoot(n), '.analytics-summary.json'); }
function dailyDir(n)    { return path.join(projectRoot(n), '.analytics-daily'); }

function emptySummary() {
  return {
    version: 1, started_at: new Date().toISOString(), last_event_at: null,
    events_total: 0, by_type: {}, by_message_type: {}, by_chat_type: {},
    by_language: {}, by_country_guess: {}, by_command: {},
    by_hour_utc: Array(24).fill(0), by_dow_utc: Array(7).fill(0), by_day: {},
    users_total: 0, users_premium: 0, users_active_7d: 0, users_active_30d: 0, by_user: {},
    subscribed: 0, unsubscribed: 0,
    payments_total_count: 0, payments_total_amount_by_currency: {},
  };
}

function loadSummary(n) {
  const p = summaryPath(n);
  if (!fs.existsSync(p)) return emptySummary();
  try {
    const raw  = JSON.parse(fs.readFileSync(p, 'utf8'));
    const skel = emptySummary();
    return { ...skel, ...raw,
      by_hour_utc: Array.isArray(raw.by_hour_utc) && raw.by_hour_utc.length === 24 ? raw.by_hour_utc : skel.by_hour_utc,
      by_dow_utc:  Array.isArray(raw.by_dow_utc)  && raw.by_dow_utc.length  === 7  ? raw.by_dow_utc  : skel.by_dow_utc,
      by_user: raw.by_user || {},
      payments_total_amount_by_currency: raw.payments_total_amount_by_currency || {},
    };
  } catch { return emptySummary(); }
}

function saveSummary(n, s) {
  const p   = summaryPath(n);
  const tmp = p + '.tmp';
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, p); }
  catch (e) { _ctx.logger.error('[analytics] summary save failed for', n + ':', e.message); }
}

const cache = new Map();
function getCached(n) {
  if (!cache.has(n)) cache.set(n, loadSummary(n));
  return cache.get(n);
}

function rotateIfNeeded(n) {
  const lp = logPath(n);
  if (!fs.existsSync(lp) || fs.statSync(lp).size < MAX_BYTES_BEFORE_ROTATE) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(lp, path.join(path.dirname(lp), '.analytics-archive-' + ts + '.jsonl'));
}

function inferUpdateType(u) {
  for (const k of ['message','edited_message','channel_post','edited_channel_post','callback_query',
    'inline_query','chosen_inline_result','shipping_query','pre_checkout_query','poll','poll_answer',
    'my_chat_member','chat_member','chat_join_request'])
    if (u[k]) return k;
  return 'unknown';
}

function inferMessageType(m) {
  if (!m) return null;
  for (const k of ['text','photo','video','video_note','voice','audio','document','sticker',
    'animation','location','contact','poll','dice','successful_payment','new_chat_members','left_chat_member'])
    if (m[k]) return k;
  return 'other';
}

function extractUser(u) {
  return u.message?.from||u.edited_message?.from||u.callback_query?.from||
    u.inline_query?.from||u.chosen_inline_result?.from||u.shipping_query?.from||
    u.pre_checkout_query?.from||u.poll_answer?.user||u.my_chat_member?.from||
    u.chat_member?.from||u.chat_join_request?.from||null;
}
function extractChat(u) {
  return u.message?.chat||u.edited_message?.chat||u.channel_post?.chat||
    u.callback_query?.message?.chat||u.my_chat_member?.chat||
    u.chat_member?.chat||u.chat_join_request?.chat||null;
}

function buildEvent(upd) {
  const at   = new Date().toISOString();
  const type = inferUpdateType(upd);
  const user = extractUser(upd);
  const chat = extractChat(upd);
  const ev   = { update_id: upd.update_id || null, type, at };
  if (user) {
    ev.user = { id: user.id, username: user.username||null, first_name: user.first_name||null,
      last_name: user.last_name||null, is_premium: !!user.is_premium, is_bot: !!user.is_bot, language_code: user.language_code||null };
    ev.country_guess = guessCountry(user.language_code);
  }
  if (chat) ev.chat = { id: chat.id, type: chat.type };
  if (['message','edited_message','channel_post'].includes(type)) {
    const msg = upd.message||upd.edited_message||upd.channel_post;
    ev.message_type = inferMessageType(msg);
    if (msg.text) { ev.text_length = msg.text.length; const m = msg.text.match(/^\/([a-zA-Z0-9_]+)/); if (m) ev.command = '/'+m[1].toLowerCase(); }
    if (msg.successful_payment) ev.payment = { currency: msg.successful_payment.currency, total_amount: msg.successful_payment.total_amount, invoice_payload: (msg.successful_payment.invoice_payload||'').slice(0,80) };
  } else if (type === 'callback_query') ev.callback_data = (upd.callback_query.data||'').slice(0,80);
  else if (type === 'my_chat_member') { ev.member_old_status = upd.my_chat_member.old_chat_member?.status||null; ev.member_new_status = upd.my_chat_member.new_chat_member?.status||null; }
  return ev;
}

function inc(obj, k, by = 1) { if (k) obj[k] = (obj[k]||0) + by; }

function applyEvent(s, ev) {
  s.events_total++; s.last_event_at = ev.at;
  inc(s.by_type, ev.type);
  if (ev.message_type) inc(s.by_message_type, ev.message_type);
  if (ev.chat?.type)   inc(s.by_chat_type, ev.chat.type);
  if (ev.user?.language_code) inc(s.by_language, ev.user.language_code);
  if (ev.country_guess) inc(s.by_country_guess, ev.country_guess);
  if (ev.command) inc(s.by_command, ev.command);
  const d = new Date(ev.at);
  s.by_hour_utc[d.getUTCHours()]++;
  s.by_dow_utc[d.getUTCDay()]++;
  inc(s.by_day, d.toISOString().slice(0,10));
  if (Object.keys(s.by_day).length > 60) { const k = Object.keys(s.by_day).sort(); for (const x of k.slice(0, k.length-60)) delete s.by_day[x]; }
  if (ev.user && !ev.user.is_bot) {
    const uid = String(ev.user.id);
    let u = s.by_user[uid];
    if (!u && Object.keys(s.by_user).length < MAX_USERS_IN_SUMMARY) {
      u = { first_seen: ev.at, last_seen: ev.at, events: 0, premium: ev.user.is_premium, lang: ev.user.language_code||null, country: ev.country_guess||null, name: ev.user.first_name||null, username: ev.user.username||null };
      s.by_user[uid] = u; s.users_total++; if (ev.user.is_premium) s.users_premium++;
    }
    if (u) { u.last_seen = ev.at; u.events++; if (ev.user.username) u.username = ev.user.username; if (ev.user.first_name) u.name = ev.user.first_name; const was = u.premium; u.premium = ev.user.is_premium; if (!was && u.premium) s.users_premium++; if (was && !u.premium) s.users_premium--; }
  }
  if (ev.type === 'my_chat_member') { const isMem = st => ['member','creator','administrator','restricted'].includes(st); if (!isMem(ev.member_old_status) && isMem(ev.member_new_status)) s.subscribed++; if (isMem(ev.member_old_status) && !isMem(ev.member_new_status)) s.unsubscribed++; }
  if (ev.command === '/start') s.subscribed++;
  if (ev.payment && ev.type === 'message' && ev.message_type === 'successful_payment') { s.payments_total_count++; inc(s.payments_total_amount_by_currency, ev.payment.currency, ev.payment.total_amount||0); }
}

function refreshActive(s) {
  const now = Date.now(); const a7 = now - 7*86400000; const a30 = now - 30*86400000;
  let n7 = 0, n30 = 0;
  for (const u of Object.values(s.by_user)) { const t = new Date(u.last_seen).getTime(); if (t>=a7) n7++; if (t>=a30) n30++; }
  s.users_active_7d = n7; s.users_active_30d = n30;
}

export function recordUpdate(projectName, upd) {
  try {
    const ev = buildEvent(upd);
    rotateIfNeeded(projectName);
    const lp = logPath(projectName);
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    fs.appendFileSync(lp, JSON.stringify(ev) + '\n');
    const s = getCached(projectName);
    applyEvent(s, ev);
    saveSummary(projectName, s);
  } catch (e) { _ctx.logger.error('[analytics] record failed for', projectName + ':', e.message); }
}

export function getSummary(projectName) {
  const s = getCached(projectName);
  refreshActive(s);
  const top = (obj, n) => Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,n);
  return { started_at: s.started_at, last_event_at: s.last_event_at, events_total: s.events_total,
    users_total: s.users_total, users_premium: s.users_premium,
    premium_pct: s.users_total > 0 ? Math.round((s.users_premium/s.users_total)*100) : 0,
    users_active_7d: s.users_active_7d||0, users_active_30d: s.users_active_30d||0,
    subscribed: s.subscribed, unsubscribed: s.unsubscribed,
    payments_total_count: s.payments_total_count, payments_total_amount_by_currency: s.payments_total_amount_by_currency,
    by_type: s.by_type, by_message_type: s.by_message_type, by_chat_type: s.by_chat_type,
    by_command: s.by_command, by_hour_utc: s.by_hour_utc, by_dow_utc: s.by_dow_utc, by_day: s.by_day,
    top_languages: top(s.by_language, 10), top_countries: top(s.by_country_guess, 15),
  };
}

let snapshotTimer = null;

function takeDailySnapshot() {
  try {
    const state = _ctx.modules.drafts.getState();
    const date  = new Date(Date.now()-1000).toISOString().slice(0,10);
    for (const p of state.projects) {
      if (!p.bot?.token) continue;
      const s  = getCached(p.name); refreshActive(s);
      const dp = path.join(dailyDir(p.name), date+'.json');
      try { fs.mkdirSync(path.dirname(dp), { recursive: true }); fs.writeFileSync(dp, JSON.stringify(s)); } catch {}
      try { const d = dailyDir(p.name); if (fs.existsSync(d)) { const files = fs.readdirSync(d).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); if (files.length > SUMMARY_DAILY_KEEP_DAYS) for (const f of files.slice(0, files.length-SUMMARY_DAILY_KEEP_DAYS)) try { fs.unlinkSync(path.join(d,f)); } catch {} } } catch {}
    }
    _ctx.logger.info('[analytics] daily snapshots written for', date);
  } catch (e) { _ctx.logger.error('[analytics] daily snapshot loop failed:', e.message); }
}

// ─── Module contract ────────────────────────────────────────────────────────────
export async function init(ctx) {
  _ctx = ctx;
  const now  = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()+1, 0, 5));
  const ms   = next.getTime() - now.getTime();
  snapshotTimer = setTimeout(() => {
    takeDailySnapshot();
    setInterval(takeDailySnapshot, 24*3600*1000);
  }, ms);
  ctx.logger.info('[analytics] ready, daily snapshot in', Math.round(ms/3600000) + 'h');
}

export function mountRoutes(app, ctx) {
  // Analytics routes are mounted by the drafts module as part of its API surface.
}
