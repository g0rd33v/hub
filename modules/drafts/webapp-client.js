// modules/drafts/webapp-client.js
// Browser-side SPA — iteration 3: + Audience (analytics) section

(function() {
'use strict';

var tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }

var ROOT  = document.getElementById('root');
var BACK  = document.getElementById('back-nav');
var TOAST = document.getElementById('toast');
var TOKEN = new URLSearchParams(location.search).get('token') || '';
var BASE  = location.origin;
var STATE     = null;
var SAP_STATE = null;

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString();
}
function toast(msg) {
  TOAST.textContent = msg;
  TOAST.className = 'toast show';
  clearTimeout(TOAST._t);
  TOAST._t = setTimeout(function() { TOAST.className = 'toast'; }, 2600);
}
function timeAgo(iso) {
  if (!iso) return 'never';
  var d = Date.now() - new Date(iso);
  if (d < 60000) return Math.floor(d/1000) + 's ago';
  if (d < 3600000) return Math.floor(d/60000) + 'm ago';
  if (d < 86400000) return Math.floor(d/3600000) + 'h ago';
  return Math.floor(d/86400000) + 'd ago';
}
function api(method, url, body, token) {
  var tok = token || (STATE && STATE.pap_token);
  return fetch(url, {
    method: method,
    headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(function(r) { return r.json(); });
}

// ---- SAP view ----------------------------------------------------------------

function renderSAP(d) {
  SAP_STATE = d;
  var withBot   = d.projects.filter(function(p) { return p.has_bot; });
  var totalSubs = d.projects.reduce(function(s, p) { return s + p.subscriber_count; }, 0);
  var up        = Math.floor(d.server.uptime_sec / 60);

  var h = '<div class="ey">HUB &middot; SERVER &middot; SAP</div>';
  h += '<h1>Server dashboard.</h1>';
  h += '<p class="lead">' + d.projects.length + ' project' + (d.projects.length !== 1 ? 's' : '') + ' &middot; up ' + up + 'm</p>';
  h += '<div class="stat-grid">';
  h += '<div class="stat-box"><div class="stat-n">' + withBot.length + '</div><div class="stat-l">bots</div></div>';
  h += '<div class="stat-box"><div class="stat-n">' + totalSubs + '</div><div class="stat-l">subscribers</div></div>';
  h += '</div><hr class="divider">';

  if (!d.projects.length) {
    h += '<div class="empty">No projects yet.</div>';
  } else {
    h += '<div class="sec"><div class="sec-title">Projects</div>';
    d.projects.forEach(function(p) {
      var meta = esc(p.name);
      if (p.has_bot) meta += ' &middot; @' + esc(p.bot_username) + ' &middot; ' + p.subscriber_count + ' subs';
      h += '<div class="proj-row" data-pap="' + esc(p.pap_token || '') + '" data-name="' + esc(p.name) + '">';
      h += '<div><div class="proj-name">' + esc(p.description) + '</div>';
      h += '<div class="proj-meta">' + meta + '</div></div>';
      h += '<div style="display:flex;align-items:center;gap:6px">';
      h += p.has_bot ? '<span class="tag">bot</span>' : '<span class="tag off">no bot</span>';
      h += '<span class="chevron">&#8250;</span></div></div>';
    });
    h += '</div>';
  }
  ROOT.innerHTML = h;
  BACK.className = 'back-btn';
  document.querySelectorAll('.proj-row').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var papToken = btn.getAttribute('data-pap');
      var name     = btn.getAttribute('data-name');
      if (!papToken) { toast('no PAP token'); return; }
      showBack(name);
      fetch(BASE + '/hub/api/state?token=' + encodeURIComponent(papToken))
        .then(function(r) { return r.json(); })
        .then(function(pd) {
          if (pd.tier === 'pap') renderPAP(pd);
          else toast('failed to load');
        })
        .catch(function(e) { hideBack(); toast('error: ' + e.message); });
    });
  });
}

// ---- PAP view ----------------------------------------------------------------

function renderPAP(d) {
  STATE = d;
  var apiBase = d.api_base || (BASE + '/drafts');

  var h = '<div class="back-top">';
  h += '<div class="ey">HUB &middot; ' + esc(d.name.toUpperCase()) + ' &middot; PAP</div>';
  h += '<h1>' + esc(d.description) + '</h1>';
  h += '<p class="lead"><a href="' + esc(d.live_url) + '" target="_blank">' + esc(d.live_url) + '</a></p>';

  // --- 1. BOT
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Bot</div>';
  if (d.bot) {
    h += '<div class="card">';
    h += '<div class="card-head"><span class="dot"></span>@' + esc(d.bot.username) + '<span class="tag">' + esc(d.bot.mode) + '</span></div>';
    h += '<div class="stat-grid" style="margin-bottom:10px">';
    h += '<div class="stat-box"><div class="stat-n">' + d.bot.subscribers + '</div><div class="stat-l">subscribers</div></div>';
    var aState = d.bot.analytics_enabled ? 'on' : 'off';
    h += '<div class="stat-box"><div class="stat-n">' + aState + '</div><div class="stat-l">analytics</div></div>';
    h += '</div>';
    if (d.bot.mode === 'webhook') {
      h += '<div class="row"><span class="rk">webhook</span><span class="rv" style="font-size:11px">' + esc(d.bot.webhook_url) + '</span></div>';
      if (d.bot.webhook_log && d.bot.webhook_log.length) {
        h += '<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#444;margin:10px 0 3px">Recent calls</div>';
        h += '<table class="log-tbl">';
        d.bot.webhook_log.forEach(function(e) {
          var ok = e.status >= 200 && e.status < 300;
          var t  = e.status > 0 ? String(e.status) : (e.error || 'err');
          h += '<tr><td class="s-time">' + timeAgo(e.at) + '</td><td class="' + (ok ? 's-ok' : 's-err') + '">' + esc(t) + '</td>';
          h += '<td style="color:#444">' + (e.latency_ms || '') + 'ms</td></tr>';
        });
        h += '</table>';
      }
    }
    if (d.bot.mode === 'polling') {
      h += '<div style="margin-top:10px"><input type="url" id="webhookInput" placeholder="https://your-app.vercel.app/webhook"></div>';
    }
    var wLabel = d.bot.mode === 'polling' ? '&#8645; enable webhook' : '&#8645; switch to polling';
    h += '<div class="actions">';
    h += '<button class="btn btn-ghost" id="webhookModeBtn">' + wLabel + '</button>';
    h += '<button class="btn btn-blue" id="syncBotBtn">&#8635; sync bot</button>';
    h += '<button class="btn btn-danger" id="unlinkBotBtn">unlink</button>';
    h += '</div></div>';

    // Broadcast
    var subWord = d.bot.subscribers === 1 ? 'subscriber' : 'subscribers';
    h += '<div class="card">';
    h += '<div class="card-head"><span class="tag blue">broadcast</span></div>';
    h += '<div class="muted" style="margin-bottom:8px">Send to all ' + d.bot.subscribers + ' ' + subWord + '.</div>';
    h += '<textarea id="broadcastMsg" rows="3" placeholder="What is new?"></textarea>';
    h += '<div class="actions"><button class="btn btn-prim btn-full" id="broadcastBtn">&#8801; send broadcast</button></div>';
    h += '</div>';
  } else {
    h += '<div class="card">';
    h += '<div class="muted" style="margin-bottom:10px">No bot linked. Get a token from @BotFather.</div>';
    h += '<input type="text" id="botTokenInput" placeholder="123456:ABC...">';
    h += '<div class="actions"><button class="btn btn-prim btn-full" id="linkBotBtn">Link bot</button></div>';
    h += '</div>';
  }
  h += '</div>';

  // --- 2. AUDIENCE (analytics placeholder — loaded async)
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Audience</div>';
  if (d.bot) {
    h += '<div id="audienceSection"><div class="card"><div class="muted">Loading analytics...</div></div></div>';
  } else {
    h += '<div class="card"><div class="muted">Link a bot to see audience analytics.</div></div>';
  }
  h += '</div>';

  // --- 3. GITHUB
  var ghDot = d.github && d.github.repo ? '' : 'off';
  h += '<hr class="divider"><div class="sec"><div class="sec-title">GitHub</div><div class="card">';
  h += '<div class="card-head"><span class="dot ' + ghDot + '"></span>github</div>';
  if (d.github && d.github.repo) {
    h += '<div class="row"><span class="rk">repo</span><span class="rv">' + esc(d.github.repo) + '</span></div>';
    var acls = d.github.autosync ? 'toggle on' : 'toggle';
    h += '<div class="toggle-row"><div><div style="font-size:13px;font-weight:600">auto-sync</div><div class="muted">push on every commit</div></div>';
    h += '<button class="' + acls + '" id="autosyncToggle"></button></div>';
    h += '<div class="actions">';
    h += '<button class="btn btn-ghost" id="githubSyncBtn">&#8593; push now</button>';
    h += '<button class="btn btn-danger" id="githubUnlinkBtn">unlink</button>';
    h += '</div>';
  } else {
    h += '<input type="text" id="githubRepoInput" placeholder="owner/repo">';
    h += '<div class="actions"><button class="btn btn-prim btn-full" id="githubLinkBtn">&#128279; link repo</button></div>';
  }
  h += '</div></div>';

  // --- 4. CONTRIBUTORS
  var cCount = d.aaps && d.aaps.length ? ' (' + d.aaps.length + ')' : '';
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Contributors' + cCount + '</div>';
  if (d.aaps && d.aaps.length) {
    d.aaps.forEach(function(a) {
      h += '<div class="card"><div class="row"><span class="rk">' + esc(a.name) + '</span>';
      h += '<span class="rv"><a href="' + esc(a.url) + '">dashboard</a></span></div></div>';
    });
  } else {
    h += '<div class="card"><div class="muted">No contributors yet.</div></div>';
  }
  h += '</div>';

  // --- 5. YOUR PASS
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Your pass (PAP)</div>';
  h += '<div class="card"><div class="muted" style="margin-bottom:8px">Bookmark this link.</div>';
  h += '<div class="actions"><button class="btn btn-ghost" id="copyPAPBtn">&#128203; copy link</button></div></div>';
  h += '</div></div>';

  ROOT.innerHTML = h;

  // Wire events
  var el = function(id) { return document.getElementById(id); };

  if (el('linkBotBtn')) {
    el('linkBotBtn').addEventListener('click', function() {
      var t = el('botTokenInput') && el('botTokenInput').value.trim();
      if (!t) return;
      api('PUT', apiBase + '/project/bot', { token: t })
        .then(function(r) {
          if (r.ok) { toast('Bot linked: @' + r.bot.bot_username); setTimeout(reloadPAP, 600); }
          else toast('Failed: ' + (r.detail || r.error));
        }).catch(function(e) { toast('Error: ' + e.message); });
    });
  }
  if (el('unlinkBotBtn')) {
    el('unlinkBotBtn').addEventListener('click', function() {
      if (!confirm('Unlink this bot?')) return;
      api('DELETE', apiBase + '/project/bot')
        .then(function(r) {
          if (r.ok) { toast('Bot unlinked'); setTimeout(reloadPAP, 600); }
          else toast('Failed: ' + r.error);
        }).catch(function(e) { toast('Error: ' + e.message); });
    });
  }
  if (el('webhookModeBtn')) {
    el('webhookModeBtn').addEventListener('click', function() {
      if (d.bot.mode === 'polling') {
        var url = el('webhookInput') && el('webhookInput').value.trim();
        if (!url) { toast('Enter webhook URL first'); return; }
        api('PUT', apiBase + '/project/bot/webhook', { url: url })
          .then(function(r) {
            if (r.ok) { toast('Webhook enabled'); setTimeout(reloadPAP, 600); }
            else toast('Failed: ' + (r.detail || r.error));
          }).catch(function(e) { toast('Error: ' + e.message); });
      } else {
        api('DELETE', apiBase + '/project/bot/webhook')
          .then(function(r) {
            if (r.ok) { toast('Switched to polling'); setTimeout(reloadPAP, 600); }
            else toast('Failed: ' + r.error);
          }).catch(function(e) { toast('Error: ' + e.message); });
      }
    });
  }
  if (el('syncBotBtn')) {
    el('syncBotBtn').addEventListener('click', function() {
      api('POST', BASE + '/hub/api/bot/sync', {})
        .then(function(r) {
          if (r.ok) toast('Bot synced to Telegram');
          else toast('Failed: ' + (r.error || r.detail));
        }).catch(function(e) { toast('Error: ' + e.message); });
    });
  }
  if (el('broadcastBtn')) {
    el('broadcastBtn').addEventListener('click', function() {
      var msg = el('broadcastMsg') && el('broadcastMsg').value.trim();
      var btn = el('broadcastBtn');
      btn.textContent = 'Sending...';
      btn.disabled = true;
      api('POST', BASE + '/hub/api/broadcast', { message: msg })
        .then(function(r) {
          if (r.ok) {
            var sent = r.sent || 0;
            toast('Sent to ' + sent + (sent === 1 ? ' subscriber' : ' subscribers') + (r.skipped ? ' (' + r.skipped + ' skipped)' : ''));
            if (el('broadcastMsg')) el('broadcastMsg').value = '';
          } else toast('Failed: ' + (r.error || r.detail));
        })
        .catch(function(e) { toast('Error: ' + e.message); })
        .finally(function() { btn.textContent = '\u2261 send broadcast'; btn.disabled = false; });
    });
  }
  if (el('autosyncToggle')) {
    el('autosyncToggle').addEventListener('click', function() {
      var next = !(d.github && d.github.autosync);
      if (d.github) d.github.autosync = next;
      this.className = next ? 'toggle on' : 'toggle';
      api('PUT', apiBase + '/project/github-autosync', { enabled: next })
        .then(function() { toast(next ? 'Auto-sync on' : 'Auto-sync off'); })
        .catch(function(e) { toast('Error: ' + e.message); });
    });
  }
  if (el('githubSyncBtn')) {
    el('githubSyncBtn').addEventListener('click', function() {
      api('POST', apiBase + '/github/sync', {})
        .then(function(r) {
          if (r.ok) toast('Pushed to GitHub');
          else toast('Failed: ' + (r.error || r.detail));
        }).catch(function(e) { toast('Error: ' + e.message); });
    });
  }
  if (el('githubLinkBtn'))   el('githubLinkBtn').addEventListener('click', function() { toast('Use web dashboard to link GitHub'); });
  if (el('githubUnlinkBtn')) el('githubUnlinkBtn').addEventListener('click', function() { toast('Use web dashboard to unlink GitHub'); });
  if (el('copyPAPBtn')) {
    el('copyPAPBtn').addEventListener('click', function() {
      var url = d.pap_url || location.href;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function() { toast('Link copied'); });
      else toast('Copy: ' + url);
    });
  }

  // Load analytics async
  if (d.bot) loadAudience(d.pap_token);
}

// ---- Audience (analytics) section -------------------------------------------

function loadAudience(papToken) {
  fetch(BASE + '/hub/api/analytics?token=' + encodeURIComponent(papToken))
    .then(function(r) { return r.json(); })
    .then(function(a) { renderAudience(a); })
    .catch(function(e) {
      var sec = document.getElementById('audienceSection');
      if (sec) sec.innerHTML = '<div class="card"><div class="muted">Analytics unavailable.</div></div>';
    });
}

function renderAudience(s) {
  var sec = document.getElementById('audienceSection');
  if (!sec) return;

  if (!s || s.error) {
    sec.innerHTML = '<div class="card"><div class="muted">No analytics data yet.</div></div>';
    return;
  }

  var h = '';

  // Stat boxes: 4 numbers
  h += '<div class="stat-grid stat-grid-4">';
  h += '<div class="stat-box"><div class="stat-n">' + fmtNum(s.users_total) + '</div><div class="stat-l">users</div></div>';
  h += '<div class="stat-box"><div class="stat-n">' + fmtNum(s.events_total) + '</div><div class="stat-l">events</div></div>';
  h += '<div class="stat-box"><div class="stat-n">' + fmtNum(s.users_active_7d) + '</div><div class="stat-l">DAU 7d</div></div>';
  h += '<div class="stat-box"><div class="stat-n">' + fmtNum(s.users_active_30d) + '</div><div class="stat-l">DAU 30d</div></div>';
  h += '</div>';

  // Languages + Countries side by side
  var byLang = s.by_language || {};
  var byCoun = s.by_country || {};
  var langEntries = Object.entries(byLang).sort(function(a,b){ return b[1]-a[1]; }).slice(0,6);
  var counEntries = Object.entries(byCoun).sort(function(a,b){ return b[1]-a[1]; }).slice(0,6);

  if (langEntries.length || counEntries.length) {
    h += '<div class="two-col">';
    if (langEntries.length) {
      var lTotal = langEntries.reduce(function(s,x){ return s+x[1]; }, 0) || 1;
      h += '<div>';
      h += '<div class="mini-title">Languages</div>';
      langEntries.forEach(function(x) {
        var pct = Math.round((x[1]/lTotal)*100);
        h += '<div class="bar-row"><span class="bar-label">' + esc(x[0]) + '</span>';
        h += '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>';
        h += '<span class="bar-n">' + x[1] + '</span></div>';
      });
      h += '</div>';
    }
    if (counEntries.length) {
      var cTotal = counEntries.reduce(function(s,x){ return s+x[1]; }, 0) || 1;
      h += '<div>';
      h += '<div class="mini-title">Countries</div>';
      counEntries.forEach(function(x) {
        var pct = Math.round((x[1]/cTotal)*100);
        h += '<div class="bar-row"><span class="bar-label">' + esc(x[0]) + '</span>';
        h += '<div class="bar-track"><div class="bar-fill bar-fill-purple" style="width:' + pct + '%"></div></div>';
        h += '<span class="bar-n">' + x[1] + '</span></div>';
      });
      h += '</div>';
    }
    h += '</div>';
  }

  // Peak hours chart (24 bars)
  var byHour = s.by_hour_utc;
  if (byHour && byHour.length === 24) {
    var hMax = Math.max.apply(null, byHour) || 1;
    h += '<div class="mini-title" style="margin-top:12px">Peak hours (UTC)</div>';
    h += '<div class="hour-chart">';
    for (var i = 0; i < 24; i++) {
      var hPct = Math.round((byHour[i] / hMax) * 100);
      var isTop = byHour[i] === hMax && hMax > 0;
      h += '<div class="hour-bar-wrap" title="' + i + 'h: ' + byHour[i] + ' events">';
      h += '<div class="hour-bar' + (isTop ? ' hour-bar-top' : '') + '" style="height:' + Math.max(hPct, 4) + '%"></div>';
      h += '<div class="hour-label">' + (i % 6 === 0 ? i + 'h' : '') + '</div>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Day of week
  var byDow = s.by_dow_utc;
  var dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (byDow && byDow.length === 7) {
    var dMax = Math.max.apply(null, byDow) || 1;
    h += '<div class="mini-title" style="margin-top:10px">Day of week</div>';
    h += '<div class="dow-chart">';
    for (var j = 0; j < 7; j++) {
      var dPct = Math.round((byDow[j] / dMax) * 100);
      h += '<div class="dow-bar-wrap" title="' + dowNames[j] + ': ' + byDow[j] + '">';
      h += '<div class="dow-bar" style="height:' + Math.max(dPct, 4) + '%"></div>';
      h += '<div class="dow-label">' + dowNames[j] + '</div>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Commands
  var byCmd = s.by_command || {};
  var cmdEntries = Object.entries(byCmd).sort(function(a,b){ return b[1]-a[1]; }).slice(0,6);
  if (cmdEntries.length) {
    h += '<div class="mini-title" style="margin-top:10px">Commands</div>';
    h += '<div class="cmd-list">';
    cmdEntries.forEach(function(x) {
      h += '<div class="row"><span class="rk">' + esc(x[0]) + '</span><span class="rv">' + fmtNum(x[1]) + ' times</span></div>';
    });
    h += '</div>';
  }

  // Footer stats
  h += '<div style="margin-top:10px;display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:#555">';
  if (s.subscribed != null) h += '<span>+' + s.subscribed + ' subscribed</span>';
  if (s.unsubscribed) h += '<span>&minus;' + s.unsubscribed + ' left</span>';
  if (s.last_event_at) h += '<span>last event: ' + timeAgo(s.last_event_at) + '</span>';
  h += '</div>';

  // Toggle analytics + actions
  h += '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">';
  h += '<button class="btn btn-ghost" id="analyticsDownloadBtn" style="font-size:12px">&#8595; download data</button>';
  h += '</div>';

  sec.innerHTML = h;

  // Download analytics
  var dlBtn = document.getElementById('analyticsDownloadBtn');
  if (dlBtn) {
    dlBtn.addEventListener('click', function() {
      var tok = STATE && STATE.pap_token;
      window.location.href = BASE + '/hub/api/analytics/download?token=' + encodeURIComponent(tok || TOKEN);
    });
  }
}

// ---- AAP view ----------------------------------------------------------------

function renderAAP(d) {
  var h = '<div class="ey">HUB &middot; ' + esc(d.name.toUpperCase()) + ' &middot; AAP</div>';
  h += '<h1>' + esc(d.aap_name) + '</h1>';
  h += '<p class="lead">Contributor on <a href="' + esc(d.live_url) + '">' + esc(d.name) + '</a> &middot; branch: <code>' + esc(d.branch) + '</code></p>';
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Build loop</div>';
  h += '<div class="card">';
  h += '<div class="row"><span class="rk">upload</span><span class="rv" style="font-size:11px">POST /drafts/upload {filename, content}</span></div>';
  h += '<div class="row"><span class="rk">commit</span><span class="rv" style="font-size:11px">POST /drafts/commit {message}</span></div>';
  h += '<div class="row"><span class="rk">promote</span><span class="rv" style="font-size:11px">POST /drafts/promote</span></div>';
  h += '</div></div>';
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Your pass (AAP)</div>';
  h += '<div class="card"><div class="muted" style="margin-bottom:8px">Contributor pass.</div>';
  h += '<div class="actions"><button class="btn btn-ghost" id="copyAAPBtn">&#128203; copy link</button></div></div>';
  h += '</div>';
  ROOT.innerHTML = h;
  var btn = document.getElementById('copyAAPBtn');
  if (btn) btn.addEventListener('click', function() {
    var url = d.aap_url || location.href;
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function() { toast('Copied'); });
    else toast('Copy: ' + url);
  });
}

// ---- Navigation --------------------------------------------------------------

function showBack(label) {
  BACK.className = 'back-btn show';
  document.getElementById('back-label').textContent = label || 'back';
}
function hideBack() { BACK.className = 'back-btn'; }

BACK.addEventListener('click', function() {
  hideBack();
  if (SAP_STATE) renderSAP(SAP_STATE);
  else load();
});

function reloadPAP() {
  var tok = (STATE && STATE.pap_token) || TOKEN;
  fetch(BASE + '/hub/api/state?token=' + encodeURIComponent(tok))
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.tier === 'pap') renderPAP(d); })
    .catch(function(e) { toast('Reload failed: ' + e.message); });
}

// ---- Boot --------------------------------------------------------------------

function load() {
  if (!TOKEN) {
    ROOT.innerHTML = '<div class="card"><div class="card-head">Open from Telegram</div><div class="muted">This dashboard works inside the Telegram app. Open it via the bot.</div></div>';
    return;
  }
  fetch(BASE + '/hub/api/state?token=' + encodeURIComponent(TOKEN))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      STATE = d;
      if      (d.tier === 'sap') renderSAP(d);
      else if (d.tier === 'pap') renderPAP(d);
      else if (d.tier === 'aap') renderAAP(d);
      else ROOT.innerHTML = '<div class="empty">Unknown tier.</div>';
    })
    .catch(function(e) {
      ROOT.innerHTML = '<div class="card"><div class="card-head">Error</div><div class="muted">' + esc(e.message) + '</div></div>';
    });
}

load();

})();
