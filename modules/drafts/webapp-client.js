// modules/drafts/webapp-client.js — Hub v0.3
// Browser SPA: SAP / PAP / AAP views
// Loaded as static file at /hub/webapp-client.js

(function () {
'use strict';

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const ROOT  = document.getElementById('root');
const BACK  = document.getElementById('back-nav');
const TOAST = document.getElementById('toast');
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const BASE  = location.origin;

let STATE     = null; // current PAP/AAP state (for reload)
let SAP_STATE = null; // cached SAP state (for back-nav)

// ── Utilities ─────────────────────────────────────────────────────────────────

const esc = s => s == null ? ''
  : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const fmtNum = n => n == null ? '0' : Number(n).toLocaleString();

const timeAgo = iso => {
  if (!iso) return 'never';
  const d = Date.now() - new Date(iso);
  if (d < 60_000)    return `${Math.floor(d / 1_000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
};

const toast = msg => {
  TOAST.textContent = msg;
  TOAST.className = 'toast show';
  clearTimeout(TOAST._t);
  TOAST._t = setTimeout(() => { TOAST.className = 'toast'; }, 2600);
};

const apiCall = (method, url, body, tokenOverride) => {
  const tok = tokenOverride || STATE?.pap_token;
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body:    body ? JSON.stringify(body) : undefined,
  }).then(r => r.json());
};

const el = id => document.getElementById(id);

// ── Navigation ────────────────────────────────────────────────────────────────

const showBack = label => {
  BACK.className = 'back-btn show';
  document.getElementById('back-label').textContent = label || 'back';
};
const hideBack = () => { BACK.className = 'back-btn'; };

BACK.addEventListener('click', () => {
  hideBack();
  if (SAP_STATE) renderSAP(SAP_STATE);
  else           load();
});

const reloadPAP = () => {
  const tok = STATE?.pap_token || TOKEN;
  fetch(`${BASE}/hub/api/state?token=${encodeURIComponent(tok)}`)
    .then(r => r.json())
    .then(d => { if (d.tier === 'pap') renderPAP(d); })
    .catch(e => toast(`Reload failed: ${e.message}`));
};

// ── SAP view ──────────────────────────────────────────────────────────────────

const renderSAP = d => {
  SAP_STATE = d;
  const up       = Math.floor(d.server.uptime_sec / 60);
  const withBot  = d.projects.filter(p => p.has_bot);
  const totalSub = d.projects.reduce((s, p) => s + p.subscriber_count, 0);

  let h = `<div class="ey">HUB &middot; SERVER &middot; SAP</div>`;
  h    += `<h1>Server dashboard.</h1>`;
  h    += `<p class="lead">${d.projects.length} project${d.projects.length !== 1 ? 's' : ''} &middot; up ${up}m</p>`;
  h    += `<div class="stat-grid">`;
  h    += `<div class="stat-box"><div class="stat-n">${withBot.length}</div><div class="stat-l">bots</div></div>`;
  h    += `<div class="stat-box"><div class="stat-n">${totalSub}</div><div class="stat-l">subscribers</div></div>`;
  h    += `</div><hr class="divider">`;

  if (!d.projects.length) {
    h += `<div class="empty">No projects yet.</div>`;
  } else {
    h += `<div class="sec"><div class="sec-title">Projects</div>`;
    for (const p of d.projects) {
      const meta = p.has_bot
        ? `${esc(p.name)} &middot; @${esc(p.bot_username)} &middot; ${p.subscriber_count} subs`
        : esc(p.name);
      h += `<div class="proj-row" data-pap="${esc(p.pap_token||'')}" data-name="${esc(p.name)}">`;
      h += `<div><div class="proj-name">${esc(p.description)}</div><div class="proj-meta">${meta}</div></div>`;
      h += `<div style="display:flex;align-items:center;gap:6px">`;
      h += p.has_bot ? `<span class="tag">bot</span>` : `<span class="tag off">no bot</span>`;
      h += `<span class="chevron">&#8250;</span></div></div>`;
    }
    h += `</div>`;
  }

  ROOT.innerHTML = h;
  BACK.className = 'back-btn';

  ROOT.querySelectorAll('.proj-row').forEach(btn => {
    btn.addEventListener('click', () => {
      const papToken = btn.dataset.pap;
      const name     = btn.dataset.name;
      if (!papToken) { toast('No PAP token'); return; }
      showBack(name);
      fetch(`${BASE}/hub/api/state?token=${encodeURIComponent(papToken)}`)
        .then(r => r.json())
        .then(pd => { if (pd.tier === 'pap') renderPAP(pd); else toast('Failed to load'); })
        .catch(e => { hideBack(); toast(`Error: ${e.message}`); });
    });
  });
};

// ── PAP view ──────────────────────────────────────────────────────────────────

const renderPAP = d => {
  STATE = d;
  const apiBase = d.api_base || `${BASE}/drafts`;

  let h = `<div class="back-top">`;
  h    += `<div class="ey">HUB &middot; ${esc(d.name.toUpperCase())} &middot; PAP</div>`;
  h    += `<h1>${esc(d.description)}</h1>`;
  h    += `<p class="lead"><a href="${esc(d.live_url)}" target="_blank">${esc(d.live_url)}</a></p>`;

  // ── 1. BOT
  h += `<hr class="divider"><div class="sec"><div class="sec-title">Bot</div>`;
  if (d.bot) {
    h += `<div class="card">`;
    h += `<div class="card-head"><span class="dot"></span>@${esc(d.bot.username)}<span class="tag">${esc(d.bot.mode)}</span></div>`;
    h += `<div class="stat-grid" style="margin-bottom:10px">`;
    h += `<div class="stat-box"><div class="stat-n">${d.bot.subscribers}</div><div class="stat-l">subscribers</div></div>`;
    h += `<div class="stat-box"><div class="stat-n">${d.bot.analytics_enabled ? 'on' : 'off'}</div><div class="stat-l">analytics</div></div>`;
    h += `</div>`;

    if (d.bot.mode === 'webhook') {
      h += `<div class="row"><span class="rk">webhook</span><span class="rv" style="font-size:11px">${esc(d.bot.webhook_url)}</span></div>`;
      if (d.bot.webhook_log?.length) {
        h += `<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#444;margin:10px 0 3px">Recent calls</div>`;
        h += `<table class="log-tbl">`;
        for (const e of d.bot.webhook_log) {
          const ok  = e.status >= 200 && e.status < 300;
          const txt = e.status > 0 ? String(e.status) : (e.error || 'err');
          h += `<tr><td class="s-time">${timeAgo(e.at)}</td><td class="${ok ? 's-ok' : 's-err'}">${esc(txt)}</td><td style="color:#444">${e.latency_ms || ''}ms</td></tr>`;
        }
        h += `</table>`;
      }
    }

    if (d.bot.mode === 'polling') {
      h += `<div style="margin-top:10px"><input type="url" id="webhookInput" placeholder="https://your-app.vercel.app/webhook"></div>`;
    }
    const wLabel = d.bot.mode === 'polling' ? '&#8645; enable webhook' : '&#8645; polling mode';
    h += `<div class="actions">`;
    h += `<button class="btn btn-ghost" id="webhookModeBtn">${wLabel}</button>`;
    h += `<button class="btn btn-blue" id="syncBotBtn">&#8635; sync bot</button>`;
    h += `<button class="btn btn-danger" id="unlinkBotBtn">unlink</button>`;
    h += `</div></div>`;

    // Broadcast
    const subWord = d.bot.subscribers === 1 ? 'subscriber' : 'subscribers';
    h += `<div class="card">`;
    h += `<div class="card-head"><span class="tag blue">broadcast</span></div>`;
    h += `<div class="muted" style="margin-bottom:8px">Send to all ${d.bot.subscribers} ${subWord}.</div>`;
    h += `<div class="broadcast-area"><textarea id="broadcastMsg" rows="3" placeholder="What is new?"></textarea></div>`;
    h += `<div class="actions"><button class="btn btn-prim btn-full" id="broadcastBtn">&#8801; send broadcast</button></div>`;
    h += `</div>`;
  } else {
    h += `<div class="card">`;
    h += `<div class="muted" style="margin-bottom:10px">No bot linked. Get a token from @BotFather.</div>`;
    h += `<input type="text" id="botTokenInput" placeholder="123456:ABC...">`;
    h += `<div class="actions"><button class="btn btn-prim btn-full" id="linkBotBtn">Link bot</button></div>`;
    h += `</div>`;
  }
  h += `</div>`;

  // ── 2. AUDIENCE
  h += `<hr class="divider"><div class="sec"><div class="sec-title">Audience</div>`;
  h += d.bot
    ? `<div id="audienceSection"><div class="card"><div class="muted">Loading analytics&hellip;</div></div></div>`
    : `<div class="card"><div class="muted">Link a bot to see audience data.</div></div>`;
  h += `</div>`;

  // ── 3. GITHUB
  h += `<hr class="divider"><div class="sec"><div class="sec-title">GitHub</div><div class="card">`;
  h += `<div class="card-head"><span class="dot ${d.github?.repo ? '' : 'off'}"></span>github</div>`;
  if (d.github?.repo) {
    h += `<div class="row"><span class="rk">repo</span><span class="rv">${esc(d.github.repo)}</span></div>`;
    h += `<div class="toggle-row"><div><div style="font-size:13px;font-weight:600">auto-sync</div><div class="muted">push on every commit</div></div>`;
    h += `<button class="toggle ${d.github.autosync ? 'on' : ''}" id="autosyncToggle"></button></div>`;
    h += `<div class="actions">`;
    h += `<button class="btn btn-ghost" id="githubSyncBtn">&#8593; push now</button>`;
    h += `<button class="btn btn-danger" id="githubUnlinkBtn">unlink</button>`;
    h += `</div>`;
  } else {
    h += `<input type="text" id="githubRepoInput" placeholder="owner/repo">`;
    h += `<div class="actions"><button class="btn btn-prim btn-full" id="githubLinkBtn">&#128279; link repo</button></div>`;
  }
  h += `</div></div>`;

  // ── 4. CONTRIBUTORS
  const cCount = d.aaps?.length ? ` (${d.aaps.length})` : '';
  h += `<hr class="divider"><div class="sec"><div class="sec-title">Contributors${cCount}</div>`;
  if (d.aaps?.length) {
    for (const a of d.aaps) {
      h += `<div class="card"><div class="row"><span class="rk">${esc(a.name)}</span>`;
      h += `<span class="rv"><a href="${esc(a.url)}">dashboard</a></span></div></div>`;
    }
  } else {
    h += `<div class="card"><div class="muted">No contributors yet.</div></div>`;
  }
  h += `</div>`;

  // ── 5. YOUR PASS
  h += `<hr class="divider"><div class="sec"><div class="sec-title">Your pass (PAP)</div>`;
  h += `<div class="card"><div class="muted" style="margin-bottom:8px">Bookmark this link.</div>`;
  h += `<div class="actions"><button class="btn btn-ghost" id="copyPAPBtn">&#128203; copy link</button></div></div>`;
  h += `</div></div>`; // close back-top

  ROOT.innerHTML = h;

  // Wire up bot events
  el('linkBotBtn')?.addEventListener('click', () => {
    const t = el('botTokenInput')?.value.trim();
    if (!t) return;
    apiCall('PUT', `${apiBase}/project/bot`, { token: t })
      .then(r => r.ok ? (toast(`Bot linked: @${r.bot.bot_username}`), setTimeout(reloadPAP, 600)) : toast(`Failed: ${r.detail || r.error}`))
      .catch(e => toast(`Error: ${e.message}`));
  });

  el('unlinkBotBtn')?.addEventListener('click', () => {
    if (!confirm('Unlink this bot?')) return;
    apiCall('DELETE', `${apiBase}/project/bot`)
      .then(r => r.ok ? (toast('Bot unlinked'), setTimeout(reloadPAP, 600)) : toast(`Failed: ${r.error}`))
      .catch(e => toast(`Error: ${e.message}`));
  });

  el('webhookModeBtn')?.addEventListener('click', () => {
    if (d.bot.mode === 'polling') {
      const url = el('webhookInput')?.value.trim();
      if (!url) { toast('Enter webhook URL first'); return; }
      apiCall('PUT', `${apiBase}/project/bot/webhook`, { url })
        .then(r => r.ok ? (toast('Webhook enabled'), setTimeout(reloadPAP, 600)) : toast(`Failed: ${r.detail || r.error}`))
        .catch(e => toast(`Error: ${e.message}`));
    } else {
      apiCall('DELETE', `${apiBase}/project/bot/webhook`)
        .then(r => r.ok ? (toast('Switched to polling'), setTimeout(reloadPAP, 600)) : toast(`Failed: ${r.error}`))
        .catch(e => toast(`Error: ${e.message}`));
    }
  });

  el('syncBotBtn')?.addEventListener('click', () => {
    apiCall('POST', `${BASE}/hub/api/bot/sync`, {})
      .then(r => r.ok ? toast('Bot synced to Telegram') : toast(`Failed: ${r.error || r.detail}`))
      .catch(e => toast(`Error: ${e.message}`));
  });

  el('broadcastBtn')?.addEventListener('click', () => {
    const msg = el('broadcastMsg')?.value.trim();
    const btn = el('broadcastBtn');
    btn.textContent = 'Sending...';
    btn.disabled    = true;
    apiCall('POST', `${BASE}/hub/api/broadcast`, { message: msg })
      .then(r => {
        if (r.ok) {
          const word = r.sent === 1 ? 'subscriber' : 'subscribers';
          toast(`Sent to ${r.sent} ${word}${r.skipped ? ` (${r.skipped} skipped)` : ''}`);
          if (el('broadcastMsg')) el('broadcastMsg').value = '';
        } else toast(`Failed: ${r.error || r.detail}`);
      })
      .catch(e => toast(`Error: ${e.message}`))
      .finally(() => { btn.textContent = '\u2261 send broadcast'; btn.disabled = false; });
  });

  // GitHub events
  el('autosyncToggle')?.addEventListener('click', function () {
    const next = !d.github.autosync;
    d.github.autosync  = next;
    this.className     = `toggle ${next ? 'on' : ''}`;
    apiCall('PUT', `${apiBase}/project/github-autosync`, { enabled: next })
      .then(() => toast(next ? 'Auto-sync on' : 'Auto-sync off'))
      .catch(e => toast(`Error: ${e.message}`));
  });

  el('githubSyncBtn')?.addEventListener('click', () => {
    apiCall('POST', `${apiBase}/github/sync`, {})
      .then(r => r.ok ? toast('Pushed to GitHub') : toast(`Failed: ${r.error || r.detail}`))
      .catch(e => toast(`Error: ${e.message}`));
  });

  el('githubLinkBtn')?.addEventListener('click',   () => toast('Use web dashboard to link GitHub'));
  el('githubUnlinkBtn')?.addEventListener('click', () => toast('Use web dashboard to unlink GitHub'));

  el('copyPAPBtn')?.addEventListener('click', () => {
    const url = d.pap_url || location.href;
    navigator.clipboard?.writeText(url).then(() => toast('Link copied'))
      .catch(() => toast(`Copy: ${url}`));
  });

  // Load audience analytics async
  if (d.bot) loadAudience(d.pap_token);
};

// ── Audience section ──────────────────────────────────────────────────────────

const loadAudience = papToken => {
  fetch(`${BASE}/hub/api/analytics?token=${encodeURIComponent(papToken)}`)
    .then(r => r.json())
    .then(renderAudience)
    .catch(() => {
      const sec = el('audienceSection');
      if (sec) sec.innerHTML = `<div class="card"><div class="muted">Analytics unavailable.</div></div>`;
    });
};

const renderAudience = s => {
  const sec = el('audienceSection');
  if (!sec) return;
  if (!s || s.error) {
    sec.innerHTML = `<div class="card"><div class="muted">No analytics data yet.</div></div>`;
    return;
  }

  let h = '';

  // Stat boxes
  h += `<div class="stat-grid stat-grid-4">`;
  h += `<div class="stat-box"><div class="stat-n">${fmtNum(s.users_total)}</div><div class="stat-l">users</div></div>`;
  h += `<div class="stat-box"><div class="stat-n">${fmtNum(s.events_total)}</div><div class="stat-l">events</div></div>`;
  h += `<div class="stat-box"><div class="stat-n">${fmtNum(s.users_active_7d)}</div><div class="stat-l">DAU 7d</div></div>`;
  h += `<div class="stat-box"><div class="stat-n">${fmtNum(s.users_active_30d)}</div><div class="stat-l">DAU 30d</div></div>`;
  h += `</div>`;

  // Languages + Countries side by side
  const langEntries = Object.entries(s.by_language || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const counEntries = Object.entries(s.by_country  || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);

  if (langEntries.length || counEntries.length) {
    h += `<div class="two-col">`;
    if (langEntries.length) {
      const tot = langEntries.reduce((s, [, n]) => s + n, 0) || 1;
      h += `<div><div class="mini-title">Languages</div>`;
      for (const [l, n] of langEntries) {
        const pct = Math.round((n / tot) * 100);
        h += `<div class="bar-row"><span class="bar-label">${esc(l)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-n">${n}</span></div>`;
      }
      h += `</div>`;
    }
    if (counEntries.length) {
      const tot = counEntries.reduce((s, [, n]) => s + n, 0) || 1;
      h += `<div><div class="mini-title">Countries</div>`;
      for (const [c, n] of counEntries) {
        const pct = Math.round((n / tot) * 100);
        h += `<div class="bar-row"><span class="bar-label">${esc(c)}</span><div class="bar-track"><div class="bar-fill bar-fill-purple" style="width:${pct}%"></div></div><span class="bar-n">${n}</span></div>`;
      }
      h += `</div>`;
    }
    h += `</div>`;
  }

  // Peak hours (24 bars)
  if (s.by_hour_utc?.length === 24) {
    const hMax = Math.max(...s.by_hour_utc) || 1;
    h += `<div class="mini-title" style="margin-top:12px">Peak hours (UTC)</div><div class="hour-chart">`;
    for (let i = 0; i < 24; i++) {
      const pct   = Math.round((s.by_hour_utc[i] / hMax) * 100);
      const isTop = s.by_hour_utc[i] === hMax && hMax > 0;
      h += `<div class="hour-bar-wrap" title="${i}h: ${s.by_hour_utc[i]} events">`;
      h += `<div class="hour-bar${isTop ? ' hour-bar-top' : ''}" style="height:${Math.max(pct, 4)}%"></div>`;
      h += `<div class="hour-label">${i % 6 === 0 ? `${i}h` : ''}</div>`;
      h += `</div>`;
    }
    h += `</div>`;
  }

  // Day of week (7 bars)
  const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (s.by_dow_utc?.length === 7) {
    const dMax = Math.max(...s.by_dow_utc) || 1;
    h += `<div class="mini-title" style="margin-top:10px">Day of week</div><div class="dow-chart">`;
    for (let j = 0; j < 7; j++) {
      const pct = Math.round((s.by_dow_utc[j] / dMax) * 100);
      h += `<div class="dow-bar-wrap" title="${DOW[j]}: ${s.by_dow_utc[j]}">`;
      h += `<div class="dow-bar" style="height:${Math.max(pct, 4)}%"></div>`;
      h += `<div class="dow-label">${DOW[j]}</div>`;
      h += `</div>`;
    }
    h += `</div>`;
  }

  // Top commands
  const cmdEntries = Object.entries(s.by_command || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (cmdEntries.length) {
    h += `<div class="mini-title" style="margin-top:10px">Commands</div>`;
    h += `<div class="cmd-list">`;
    for (const [cmd, n] of cmdEntries) {
      h += `<div class="row"><span class="rk">${esc(cmd)}</span><span class="rv">${fmtNum(n)} times</span></div>`;
    }
    h += `</div>`;
  }

  // Footer stats
  const footParts = [];
  if (s.subscribed)    footParts.push(`+${s.subscribed} subscribed`);
  if (s.unsubscribed)  footParts.push(`\u2212${s.unsubscribed} left`);
  if (s.last_event_at) footParts.push(`last event: ${timeAgo(s.last_event_at)}`);
  h += `<div style="margin-top:10px;font-size:12px;color:#555">${footParts.join(' &middot; ')}</div>`;
  h += `<div style="margin-top:8px"><button class="btn btn-ghost" id="analyticsDownloadBtn" style="font-size:12px">&#8595; download data</button></div>`;

  sec.innerHTML = h;

  el('analyticsDownloadBtn')?.addEventListener('click', () => {
    const tok = STATE?.pap_token || TOKEN;
    window.location.href = `${BASE}/hub/api/analytics/download?token=${encodeURIComponent(tok)}`;
  });
};

// ── AAP view ──────────────────────────────────────────────────────────────────

const renderAAP = d => {
  let h = `<div class="ey">HUB &middot; ${esc(d.name.toUpperCase())} &middot; AAP</div>`;
  h    += `<h1>${esc(d.aap_name)}</h1>`;
  h    += `<p class="lead">Contributor on <a href="${esc(d.live_url)}">${esc(d.name)}</a> &middot; branch: <code>${esc(d.branch)}</code></p>`;
  h    += `<hr class="divider"><div class="sec"><div class="sec-title">Build loop</div><div class="card">`;
  h    += `<div class="row"><span class="rk">upload</span><span class="rv" style="font-size:11px">POST /drafts/upload {filename, content}</span></div>`;
  h    += `<div class="row"><span class="rk">commit</span><span class="rv" style="font-size:11px">POST /drafts/commit {message}</span></div>`;
  h    += `<div class="row"><span class="rk">promote</span><span class="rv" style="font-size:11px">POST /drafts/promote</span></div>`;
  h    += `</div></div>`;
  h    += `<hr class="divider"><div class="sec"><div class="sec-title">Your pass (AAP)</div>`;
  h    += `<div class="card"><div class="muted" style="margin-bottom:8px">Contributor pass.</div>`;
  h    += `<div class="actions"><button class="btn btn-ghost" id="copyAAPBtn">&#128203; copy link</button></div></div>`;
  h    += `</div>`;
  ROOT.innerHTML = h;
  el('copyAAPBtn')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(d.aap_url || location.href).then(() => toast('Copied'));
  });
};

// ── Boot ──────────────────────────────────────────────────────────────────────

const load = () => {
  if (!TOKEN) {
    ROOT.innerHTML = `<div class="card"><div class="card-head">Open from Telegram</div><div class="muted">This dashboard works inside the Telegram app or via a direct link.</div></div>`;
    return;
  }
  fetch(`${BASE}/hub/api/state?token=${encodeURIComponent(TOKEN)}`)
    .then(r => r.json())
    .then(d => {
      STATE = d;
      if      (d.tier === 'sap') renderSAP(d);
      else if (d.tier === 'pap') renderPAP(d);
      else if (d.tier === 'aap') renderAAP(d);
      else ROOT.innerHTML = `<div class="empty">Unknown tier.</div>`;
    })
    .catch(e => {
      ROOT.innerHTML = `<div class="card"><div class="card-head">Error</div><div class="muted">${esc(e.message)}</div></div>`;
    });
};

load();

})();
