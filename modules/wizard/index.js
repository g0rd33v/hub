// modules/wizard/index.js — Hub Wizard
// Standalone webapp for project creation.
// Mounted at /hub/wizard?tg={telegramId}
// User fills the form, copies the result, pastes into @LabsHubBot.

import path from 'path';

let _ctx;

// ── CSS ────────────────────────────────────────────────────────────────

const CSS = [
  '*{box-sizing:border-box;margin:0;padding:0}',
  'html,body{background:#0a0a0a;color:#f0f0f0;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100%}',
  'a{color:#60a5fa;text-decoration:none}',
  '#app{max-width:500px;margin:0 auto;padding:20px 16px 80px}',
  '.ey{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#555;margin-bottom:16px}',
  'h1{font-size:22px;font-weight:800;letter-spacing:-.03em;margin-bottom:6px}',
  '.lead{font-size:13px;color:#555;margin-bottom:20px}',
  '.divider{border:none;border-top:1px solid rgba(255,255,255,.07);margin:18px 0}',
  '.field{margin-bottom:14px}',
  '.field label{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#444;margin-bottom:6px;font-weight:600}',
  'input[type=text],textarea,select{width:100%;background:#111;border:1px solid rgba(255,255,255,.1);color:#f0f0f0;padding:10px 12px;border-radius:8px;font-size:14px;font-family:inherit;transition:border-color .15s}',
  'input:focus,textarea:focus,select:focus{outline:none;border-color:rgba(255,255,255,.3)}',
  'textarea{resize:vertical;min-height:80px}',
  'select option{background:#111}',
  // Tool checkboxes
  '.tools-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
  '.tool-item{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:10px 12px;cursor:pointer;transition:border-color .15s}',
  '.tool-item:hover{border-color:rgba(255,255,255,.2)}',
  '.tool-item.selected{border-color:rgba(74,222,128,.5);background:rgba(74,222,128,.06)}',
  '.tool-item input[type=checkbox]{width:14px;height:14px;accent-color:#4ade80;cursor:pointer;flex-shrink:0}',
  '.tool-label{font-size:12px;font-weight:600}',
  '.tool-hint{font-size:10px;color:#555;margin-top:1px}',
  // Buttons
  '.btn{width:100%;padding:12px;border-radius:9px;border:none;font-size:14px;font-weight:700;cursor:pointer;transition:opacity .15s;margin-bottom:8px}',
  '.btn:active{opacity:.7}',
  '.btn-primary{background:#fff;color:#000}',
  '.btn-ghost{background:transparent;color:#888;border:1px solid rgba(255,255,255,.12)}',
  '.btn-green{background:#4ade80;color:#000}',
  // Result box
  '.result-box{background:#111;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:14px;font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;color:#ccc;white-space:pre-wrap;word-break:break-word;margin-bottom:12px;min-height:80px}',
  '.result-box.success{border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.04)}',
  // Misc
  '.muted{font-size:12px;color:#555;text-align:center;margin-top:8px}',
  '.badge{display:inline-block;font-size:10px;padding:2px 7px;border-radius:4px;background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.2);letter-spacing:.06em;text-transform:uppercase}',
  '.step-title{font-size:13px;font-weight:700;margin-bottom:10px;color:#aaa}',
  '#copyBtn{display:none}',
  '#resultSection{display:none}',
  '.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;margin-right:6px;vertical-align:middle}',
  '@keyframes spin{to{transform:rotate(360deg)}}',
  'footer{position:fixed;bottom:0;left:0;right:0;background:#0a0a0a;border-top:1px solid rgba(255,255,255,.06);padding:10px 16px;font-size:10px;color:#2a2a2a;text-align:center;font-family:ui-monospace,monospace;letter-spacing:.05em}',
].join('');

// ── Tool definitions ─────────────────────────────────────────────────

const TOOLS = [
  { id: 'telegram_bot',    icon: '\u{1F916}', label: 'Telegram bot',   hint: 'need bot token' },
  { id: 'openrouter',      icon: '\u{1F517}', label: 'OpenRouter LLM', hint: 'need API key' },
  { id: 'openai',          icon: '\u{1F9E0}', label: 'OpenAI',         hint: 'need API key' },
  { id: 'anthropic',       icon: '\u{1F4AB}', label: 'Anthropic',      hint: 'need API key' },
  { id: 'webhook',         icon: '\u{1F310}', label: 'Webhook',        hint: 'need endpoint' },
  { id: 'custom_domain',   icon: '\u{1F5FA}',  label: 'Custom domain',  hint: 'optional' },
];

// ── HTML ────────────────────────────────────────────────────────────────

const renderWizardHTML = () => `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Hub Wizard</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>${CSS}</style>
</head><body>
<div id="app">
  <div class="ey">HUB &middot; WIZARD</div>
  <h1>New project.</h1>
  <p class="lead">Fill in the details. Copy the result. Paste it into @LabsHubBot.</p>
  <hr class="divider">

  <div id="formSection">
    <div class="field">
      <label>Project name</label>
      <input type="text" id="projectName" placeholder="my-bot" maxlength="40"
             pattern="[a-z0-9_-]+" title="lowercase, hyphens and underscores only">
    </div>
    <div class="field">
      <label>What does it do?</label>
      <textarea id="projectDesc" placeholder="A Telegram bot that sends daily crypto price updates with AI summaries"></textarea>
    </div>
    <div class="field">
      <label>Type</label>
      <select id="projectType">
        <option value="bot">&#129302; Telegram bot</option>
        <option value="site">&#127760; Website</option>
        <option value="api">&#128279; API service</option>
        <option value="mixed">&#9889; Bot + Site</option>
      </select>
    </div>
    <div class="field">
      <label>Tools &amp; integrations</label>
      <div class="tools-grid" id="toolsGrid">
        ${TOOLS.map(t => `
        <label class="tool-item" id="tool_${t.id}">
          <input type="checkbox" name="tool" value="${t.id}">
          <div><div class="tool-label">${t.icon} ${t.label}</div><div class="tool-hint">${t.hint}</div></div>
        </label>`).join('')}
      </div>
    </div>
    <hr class="divider">
    <button class="btn btn-primary" id="generateBtn">&#9889; Generate project plan</button>
    <button class="btn btn-ghost" id="genAiBtn">&#10024; Let AI fill it in</button>
  </div>

  <div id="resultSection">
    <hr class="divider">
    <div class="step-title">Your project plan &mdash; copy and send to @LabsHubBot</div>
    <div class="result-box success" id="resultBox"></div>
    <button class="btn btn-green" id="copyBtn" onclick="copyResult()">&#128203; Copy &amp; send to Hub</button>
    <button class="btn btn-ghost" id="editBtn">&#9998; Edit</button>
    <p class="muted">Paste this in the @LabsHubBot chat. Hub will create the project and give you a dashboard link.</p>
  </div>
</div>
<footer>hub &middot; hub.labs.co &middot; wizard</footer>

<script>
(function() {
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) { tg.ready(); tg.expand(); }

  // Reflect tool selection visually
  document.querySelectorAll('.tool-item input').forEach(function(cb) {
    cb.addEventListener('change', function() {
      var item = cb.closest('.tool-item');
      item.classList.toggle('selected', cb.checked);
    });
  });

  // Slugify name input
  document.getElementById('projectName').addEventListener('input', function() {
    this.value = this.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  });

  // Generate plan manually
  document.getElementById('generateBtn').addEventListener('click', function() {
    buildAndShow();
  });

  // AI auto-fill
  document.getElementById('genAiBtn').addEventListener('click', async function() {
    var desc = document.getElementById('projectDesc').value.trim();
    if (!desc) { alert('Describe your project first.'); return; }
    var btn = this;
    btn.innerHTML = '<span class="spinner"></span>Thinking...';
    btn.disabled = true;
    try {
      var r = await fetch('/hub/api/wizard/generate', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ prompt: desc })
      });
      var data = await r.json();
      if (data.ok && data.plan) {
        var p = data.plan;
        document.getElementById('projectName').value = p.name || '';
        document.getElementById('projectDesc').value = p.description_long || p.description || desc;
        if (p.type) document.getElementById('projectType').value = p.type;
        // Select tools
        document.querySelectorAll('.tool-item input').forEach(function(cb) {
          cb.checked = false;
          cb.closest('.tool-item').classList.remove('selected');
        });
        var needMap = {
          bot_token: 'telegram_bot',
          openrouter_key: 'openrouter',
          openai_key: 'openai',
          anthropic_key: 'anthropic',
          webhook_url: 'webhook',
          domain: 'custom_domain'
        };
        (p.needs || []).forEach(function(n) {
          var id = needMap[n];
          if (id) {
            var cb = document.querySelector('input[value="' + id + '"]');
            if (cb) { cb.checked = true; cb.closest('.tool-item').classList.add('selected'); }
          }
        });
      }
    } catch(e) { alert('AI error: ' + e.message); }
    btn.innerHTML = '&#10024; Let AI fill it in';
    btn.disabled = false;
  });

  function buildAndShow() {
    var name = document.getElementById('projectName').value.trim();
    var desc = document.getElementById('projectDesc').value.trim();
    var type = document.getElementById('projectType').value;
    if (!name) { alert('Project name is required.'); return; }
    if (!desc) { alert('Description is required.'); return; }
    name = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    var tools = [];
    document.querySelectorAll('.tool-item input:checked').forEach(function(cb) { tools.push(cb.value); });
    var toolMap = {
      telegram_bot:  'bot_token',
      openrouter:    'openrouter_key',
      openai:        'openai_key',
      anthropic:     'anthropic_key',
      webhook:       'webhook_url',
      custom_domain: 'domain'
    };
    var needs = tools.map(function(t) { return toolMap[t] || t; });
    var payload = {
      hub_wizard: true,
      name: name,
      description: desc,
      type: type,
      needs: needs
    };
    var text = JSON.stringify(payload);
    document.getElementById('resultBox').textContent = text;
    document.getElementById('resultSection').style.display = 'block';
    document.getElementById('copyBtn').style.display = 'block';
    document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth' });
  }

  window.copyResult = function() {
    var text = document.getElementById('resultBox').textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function() {
        var btn = document.getElementById('copyBtn');
        btn.textContent = '\u2713 Copied! Paste into @LabsHubBot';
        btn.style.background = '#22c55e';
        // Also send via Telegram WebApp if available
        if (tg && tg.sendData) {
          try { tg.sendData(text); } catch(e) {}
        }
        if (tg && tg.close) {
          setTimeout(function() { tg.close(); }, 1200);
        }
      });
    } else {
      // Fallback: select the text
      var box = document.getElementById('resultBox');
      var range = document.createRange();
      range.selectNodeContents(box);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  };

  document.getElementById('editBtn').addEventListener('click', function() {
    document.getElementById('resultSection').style.display = 'none';
  });
})();
</script>
</body></html>`;

// ── Module contract ────────────────────────────────────────────────────────────

export async function init(ctx) {
  _ctx = ctx;
  ctx.logger.info('[wizard] ready');
}

export function mountRoutes(app, ctx) {
  _ctx = ctx;

  // Wizard webapp — standalone HTML, no token needed
  app.get('/hub/wizard', (req, res) => {
    res.type('html').send(renderWizardHTML());
  });

  ctx.logger.info('[wizard] mounted /hub/wizard');
}
