// modules/drafts/webapp-client.js
// Browser-side SPA for Hub dashboard
// Served as static file at /hub/webapp-client.js
// No server-side template literals — pure browser JS

(function() {
'use strict';

const tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const ROOT  = document.getElementById('root');
const BACK  = document.getElementById('back-nav');
const TOAST = document.getElementById('toast');
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const BASE  = location.origin;
let STATE     = null;
let SAP_STATE = null;

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg) {
  TOAST.textContent = msg;
  TOAST.className = 'toast show';
  clearTimeout(TOAST._t);
  TOAST._t = setTimeout(function() { TOAST.className = 'toast'; }, 2600);
}

function timeAgo(iso) {
  var d = Date.now() - new Date(iso);
  if (d < 60000) return Math.floor(d/1000) + 's ago';
  if (d < 3600000) return Math.floor(d/60000) + 'm ago';
  return Math.floor(d/3600000) + 'h ago';
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

  // 1. BOT
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Bot</div>';
  if (d.bot) {
    h += '<div class="card">';
    h += '<div class="card-head"><span class="dot"></span>@' + esc(d.bot.username) + '<span class="tag">' + esc(d.bot.mode) + '</span></div>';

    h += '<div class="stat-grid" style="margin-bottom:10px">';
    h += '<div class="stat-box"><div class="stat-n">' + d.bot.subscribers + '</div><div class="stat-l">subscribers</div></div>';
    var analState = d.bot.analytics_enabled ? 'on' : 'off';
    h += '<div class="stat-box"><div class="stat-n">' + analState + '</div><div class="stat-l">analytics</div></div>';
    h += '</div>';

    if (d.bot.mode === 'webhook') {
      h += '<div class="row"><span class="rk">webhook</span><span class="rv" style="font-size:11px">' + esc(d.bot.webhook_url) + '</span></div>';
      if (d.bot.webhook_log && d.bot.webhook_log.length) {
        h += '<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#444;margin:10px 0 3px">Recent calls</div>';
        h += '<table class="log-tbl">';
        d.bot.webhook_log.forEach(function(e) {
          var ok = e.status >= 200 && e.status < 300;
          var t  = e.status > 0 ? String(e.status) : (e.error || 'err');
          var cls = ok ? 's-ok' : 's-err';
          h += '<tr><td class="s-time">' + timeAgo(e.at) + '</td><td class="' + cls + '">' + esc(t) + '</td>';
          h += '<td style="color:#444">' + (e.latency_ms || '') + 'ms</td></tr>';
        });
        h += '</table>';
      }
    }

    if (d.bot.langs && d.bot.langs.length) {
      var total = d.bot.langs.reduce(function(s, x) { return s + x[1]; }, 0) || 1;
      h += '<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#444;margin:10px 0 3px">Audience languages</div>';
      h += '<div class="lang-bar">';
      d.bot.langs.forEach(function(x) {
        var pct = Math.round((x[1] / total) * 100);
        h += '<div class="lang-row"><span class="lang-label">' + esc(x[0]) + '</span>';
        h += '<div class="lang-track"><div class="lang-fill" style="width:' + pct + '%"></div></div>';
        h += '<span class="lang-n">' + x[1] + '</span></div>';
      });
      h += '</div>';
    }

    if (d.bot.mode === 'polling') {
      h += '<div style="margin-top:10px"><input type="url" id="webhookInput" placeholder="https://your-app.vercel.app/webhook"></div>';
    }

    var webhookLabel = d.bot.mode === 'polling' ? '&#8645; enable webhook' : '&#8645; switch to polling';
    h += '<div class="actions">';
    h += '<button class="btn btn-ghost" id="webhookModeBtn">' + webhookLabel + '</button>';
    h += '<button class="btn btn-blue" id="syncBotBtn">&#8635; sync bot</button>';
    h += '<button class="btn btn-danger" id="unlinkBotBtn">unlink</button>';
    h += '</div></div>';

    // Broadcast
    var subWord = d.bot.subscribers === 1 ? 'subscriber' : 'subscribers';
    h += '<div class="card">';
    h += '<div class="card-head"><span class="tag blue">broadcast</span></div>';
    h += '<div class="muted" style="margin-bottom:8px">Send a message to all ' + d.bot.subscribers + ' ' + subWord + '.</div>';
    h += '<div class="broadcast-area"><textarea id="broadcastMsg" rows="3" placeholder="What is new? (leave empty to just sync bot profile)"></textarea></div>';
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

  // 2. GITHUB
  var ghDot = d.github && d.github.repo ? '' : 'off';
  h += '<hr class="divider"><div class="sec"><div class="sec-title">GitHub</div><div class="card">';
  h += '<div class="card-head"><span class="dot ' + ghDot + '"></span>github</div>';
  if (d.github && d.github.repo) {
    h += '<div class="row"><span class="rk">repo</span><span class="rv">' + esc(d.github.repo) + '</span></div>';
    var autosyncClass = d.github.autosync ? 'toggle on' : 'toggle';
    h += '<div class="toggle-row"><div><div style="font-size:13px;font-weight:600">auto-sync</div><div class="muted">push on every commit</div></div>';
    h += '<button class="' + autosyncClass + '" id="autosyncToggle"></button></div>';
    h += '<div class="actions">';
    h += '<button class="btn btn-ghost" id="githubSyncBtn">&#8593; push now</button>';
    h += '<button class="btn btn-danger" id="githubUnlinkBtn">unlink</button>';
    h += '</div>';
  } else {
    h += '<input type="text" id="githubRepoInput" placeholder="owner/repo">';
    h += '<div class="actions"><button class="btn btn-prim btn-full" id="githubLinkBtn">&#128279; link repo</button></div>';
  }
  h += '</div></div>';

  // 3. CONTRIBUTORS
  var contCount = d.aaps && d.aaps.length ? ' (' + d.aaps.length + ')' : '';
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Contributors' + contCount + '</div>';
  if (d.aaps && d.aaps.length) {
    d.aaps.forEach(function(a) {
      h += '<div class="card"><div class="row"><span class="rk">' + esc(a.name) + '</span>';
      h += '<span class="rv"><a href="' + esc(a.url) + '">dashboard</a></span></div></div>';
    });
  } else {
    h += '<div class="card"><div class="muted">No contributors yet.</div></div>';
  }
  h += '</div>';

  // 4. YOUR PASS
  h += '<hr class="divider"><div class="sec"><div class="sec-title">Your pass (PAP)</div>';
  h += '<div class="card"><div class="muted" style="margin-bottom:8px">Bookmark this link. It is your project dashboard.</div>';
  h += '<div class="actions"><button class="btn btn-ghost" id="copyPAPBtn">&#128203; copy link</button></div></div>';
  h += '</div></div>'; // close back-top

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
            var sent    = r.sent || 0;
            var skipped = r.skipped || 0;
            var word    = sent === 1 ? 'subscriber' : 'subscribers';
            toast('Sent to ' + sent + ' ' + word + (skipped ? ' (' + skipped + ' skipped)' : ''));
            if (el('broadcastMsg')) el('broadcastMsg').value = '';
          } else toast('Failed: ' + (r.error || r.detail));
        })
        .catch(function(e) { toast('Error: ' + e.message); })
        .finally(function() { btn.textContent = '\u2261 send broadcast'; btn.disabled = false; });
    });
  }

  if (el('autosyncToggle')) {
    el('autosyncToggle').addEventListener('click', function() {
      var next = !d.github.autosync;
      d.github.autosync = next;
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

  if (el('githubLinkBtn'))   el('githubLinkBtn').addEventListener('click', function() { toast('GitHub link: use web dashboard'); });
  if (el('githubUnlinkBtn')) el('githubUnlinkBtn').addEventListener('click', function() { toast('GitHub unlink: use web dashboard'); });

  if (el('copyPAPBtn')) {
    el('copyPAPBtn').addEventListener('click', function() {
      var url = d.pap_url || location.href;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function() { toast('Link copied'); });
      } else toast('Copy: ' + url);
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
  h += '<div class="card"><div class="muted" style="margin-bottom:8px">Contributor pass. Your entry point.</div>';
  h += '<div class="actions"><button class="btn btn-ghost" id="copyAAPBtn">&#128203; copy link</button></div></div>';
  h += '</div>';

  ROOT.innerHTML = h;
  var btn = document.getElementById('copyAAPBtn');
  if (btn) {
    btn.addEventListener('click', function() {
      var url = d.aap_url || location.href;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function() { toast('Copied'); });
      else toast('Copy: ' + url);
    });
  }
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
