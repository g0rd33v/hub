// modules/wizard/index.js — Hub Wizard
// Standalone webapp for project creation.
// Mounted at /hub/wizard?tg={telegramId}
// Based on wizapp design: Akinator-style questions, black/orange, serif cards.
// User fills the form, Copy sends JSON to @LabsHubBot via tg.sendData or clipboard.

let _ctx;

const renderWizardHTML = () => `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Hub Wizard</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:#000;color:#f5f5f5;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
  a{color:#a8a8a8;text-decoration:underline rgba(255,255,255,.18);text-underline-offset:3px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:rgba(255,255,255,.06);padding:1px 6px;border-radius:4px}
  .wrap{max-width:720px;margin:0 auto;padding:52px 24px 96px}
  .eyebrow{display:flex;align-items:center;gap:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;letter-spacing:.16em;color:#a8a8a8;text-transform:uppercase;margin-bottom:24px}
  .dot{width:8px;height:8px;border-radius:50%;background:#ff6a3d;box-shadow:0 0 18px rgba(255,106,61,.55)}
  h1{font-size:46px;line-height:1.06;letter-spacing:-.02em;font-weight:700;margin-bottom:14px}
  h1 .accent{color:#ff6a3d}
  .lede{color:#bdbdbd;font-size:16px;line-height:1.55;max-width:580px;margin-bottom:0}
  .rule{height:1px;background:rgba(255,255,255,.08);margin:36px 0}
  h2{font-size:20px;letter-spacing:-.01em;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:10px}
  .muted{color:#9b9b9b}
  /* Step 0: name + description */
  .field{margin-bottom:14px}
  .field label{display:block;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#555;margin-bottom:6px;font-weight:600}
  input[type=text],textarea{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:#f5f5f5;padding:12px 14px;border-radius:10px;font-family:inherit;font-size:14px;outline:none;transition:border-color .15s}
  input:focus,textarea:focus{border-color:rgba(255,106,61,.6)}
  textarea{resize:vertical;min-height:70px}
  .meta-row{display:flex;align-items:center;gap:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#9b9b9b;margin-bottom:12px;flex-wrap:wrap}
  .meta-row .pcount{padding:2px 8px;border:1px solid rgba(255,255,255,.12);border-radius:999px}
  /* Tool chips */
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}
  .chip{appearance:none;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.02);color:#e8e8e8;font-size:13.5px;padding:9px 14px;border-radius:999px;cursor:pointer;transition:border-color .15s,background .15s;display:inline-flex;align-items:center;gap:7px;font-family:inherit}
  .chip:hover{border-color:rgba(255,106,61,.55);background:rgba(255,106,61,.06)}
  .chip.on{border-color:#ff6a3d;background:rgba(255,106,61,.15);color:#fff}
  /* Wizard question card */
  .progress{display:flex;align-items:center;gap:14px;margin-bottom:22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#a8a8a8;letter-spacing:.08em}
  .pbar{flex:1;height:2px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden}
  .pbar>i{display:block;height:100%;background:#ff6a3d;width:0%;transition:width .35s ease}
  .qcard{border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:28px;background:linear-gradient(180deg,rgba(255,255,255,.025),rgba(255,255,255,.01));min-height:260px;display:flex;flex-direction:column;justify-content:space-between;transition:opacity .25s ease}
  .qcard.fading{opacity:0}
  .qmeta{display:flex;align-items:center;gap:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#9b9b9b;margin-bottom:18px;flex-wrap:wrap}
  .qmeta .tag{padding:2px 8px;border:1px solid rgba(255,255,255,.12);border-radius:999px}
  .qtext{font-family:Georgia,"Times New Roman",serif;font-size:26px;line-height:1.25;letter-spacing:-.01em;color:#f5f5f5;margin-bottom:8px}
  .qhint{color:#9b9b9b;font-size:13px;margin-bottom:22px}
  .answers{display:grid;grid-template-columns:1fr 1fr 1fr 1.4fr;gap:10px}
  .ans{appearance:none;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.02);color:#f5f5f5;font-family:Inter,system-ui,sans-serif;font-size:15px;font-weight:500;padding:16px 12px;border-radius:12px;cursor:pointer;transition:border-color .15s,background .15s,transform .05s;display:flex;align-items:center;justify-content:center;gap:8px}
  .ans:hover{border-color:rgba(255,106,61,.65);background:rgba(255,106,61,.06)}
  .ans:active{transform:translateY(1px)}
  .ans.skip{color:#bdbdbd}
  .ans.primary{background:#ff6a3d;border-color:#ff6a3d;color:#0d0d0d}
  .ans.primary:hover{background:#ff7e57}
  .ans[disabled]{opacity:.35;cursor:not-allowed}
  /* Controls */
  .ctrls{display:flex;justify-content:space-between;align-items:center;margin-top:16px;gap:12px;flex-wrap:wrap}
  .ghost{background:transparent;border:1px solid rgba(255,255,255,.12);color:#cfcfcf;padding:9px 14px;border-radius:8px;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;font-family:inherit}
  .ghost:hover{border-color:rgba(255,255,255,.28);color:#fff}
  .ghost[disabled]{opacity:.35;cursor:not-allowed}
  /* Result section */
  .result-card{border:1px solid rgba(74,222,128,.3);border-radius:14px;padding:22px;background:rgba(74,222,128,.04);margin-bottom:14px}
  .result-card h3{font-size:18px;font-weight:700;margin-bottom:10px;color:#f5f5f5}
  .result-row{display:flex;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:13px}
  .result-row:last-child{border-bottom:none}
  .result-k{color:#666;width:90px;flex-shrink:0}
  .result-v{color:#ccc;word-break:break-all}
  .needs-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
  .need-tag{font-size:12px;padding:4px 10px;border:1px solid rgba(255,255,255,.12);border-radius:999px;color:#aaa;background:rgba(255,255,255,.03)}
  .need-tag.has{border-color:rgba(74,222,128,.4);color:#4ade80;background:rgba(74,222,128,.06)}
  .btn-copy{width:100%;padding:13px;border-radius:10px;border:none;background:#ff6a3d;color:#0d0d0d;font-size:15px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;font-family:inherit;transition:background .15s}
  .btn-copy:hover{background:#ff7e57}
  .btn-copy:active{transform:translateY(1px)}
  .btn-edit{width:100%;padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:transparent;color:#888;font-size:13px;cursor:pointer;margin-top:8px;font-family:inherit}
  .btn-edit:hover{color:#fff;border-color:rgba(255,255,255,.3)}
  /* History */
  .h-item{border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px 16px;background:rgba(255,255,255,.02);margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:14px;transition:border-color .15s}
  .h-item:hover{border-color:rgba(255,106,61,.35);background:rgba(255,106,61,.04)}
  .h-main{flex:1;min-width:0}
  .h-row1{display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#9b9b9b}
  .h-row1 .badge{padding:2px 8px;border:1px solid rgba(255,255,255,.12);border-radius:999px}
  .h-row1 .badge.accent{border-color:rgba(255,106,61,.4);color:#ff9b7a}
  .h-summary{color:#e8e8e8;font-size:13.5px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .h-actions{display:flex;gap:8px;flex-shrink:0}
  .icon-btn{appearance:none;background:transparent;border:1px solid rgba(255,255,255,.14);color:#cfcfcf;padding:7px 10px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;display:inline-flex;align-items:center;gap:6px}
  .icon-btn:hover{border-color:rgba(255,106,61,.55);color:#fff;background:rgba(255,106,61,.06)}
  .icon-btn.danger:hover{border-color:rgba(255,80,80,.6);color:#ffb0b0;background:rgba(255,80,80,.06)}
  .empty{color:#9b9b9b;font-size:13px;border:1px dashed rgba(255,255,255,.1);border-radius:12px;padding:16px;text-align:center}
  /* Generating */
  .gen{display:flex;align-items:center;gap:12px;color:#cfcfcf;padding:28px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;letter-spacing:.04em}
  .gen .spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.15);border-top-color:#ff6a3d;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .hidden{display:none!important}
  /* Coming Soon card */
  .coming-soon{border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:24px;background:rgba(255,255,255,.015);margin-top:8px;display:flex;gap:18px;align-items:flex-start}
  .cs-icon{font-size:28px;flex-shrink:0;margin-top:2px;opacity:.7}
  .cs-badge{display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,106,61,.4);color:#ff9b7a;margin-bottom:9px}
  .cs-title{font-size:15px;font-weight:700;color:#ccc;margin-bottom:6px}
  .cs-body{font-size:13px;color:#555;line-height:1.6}
  .cs-body b{color:#777;font-weight:600}
  .foot{margin-top:48px;padding-top:20px;border-top:1px solid rgba(255,255,255,.06);color:#555;font-size:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em}
  @media(max-width:560px){
    .wrap{padding:36px 18px 80px}
    h1{font-size:34px}
    .qtext{font-size:20px}
    .answers{grid-template-columns:1fr 1fr;gap:8px}
    .qcard{padding:20px;min-height:0}
    .coming-soon{flex-direction:column;gap:10px}
  }
  ::selection{background:rgba(255,106,61,.35);color:#fff}
</style>
</head><body>
<div class="wrap">

  <div class="eyebrow"><span class="dot"></span> HUB &middot; WIZARD</div>
  <h1>New project.<br/>Answer up to fifteen&nbsp;<span class="accent">questions</span>.</h1>
  <p class="lede">Name your project, pick what it needs, answer Yes/No/Skip. Generate any time &mdash; the result goes straight to @LabsHubBot.</p>

  <div class="rule"></div>

  <!-- STEP 0: NAME + DESCRIPTION -->
  <div id="gate-name">
    <h2>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6a3d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 5.6L20 9l-4 3.9.9 5.6L12 16l-4.9 2.5L8 12.9 4 9l5.6-1.4L12 2z"/></svg>
      Project basics
    </h2>
    <div class="meta-row"><span>step 01 &middot; name</span></div>
    <div class="field">
      <label>Project name</label>
      <input type="text" id="projName" placeholder="my-bot" maxlength="40">
    </div>
    <div class="field">
      <label>What does it do?</label>
      <textarea id="projDesc" placeholder="A Telegram bot that sends daily crypto prices with AI summaries via OpenRouter" rows="3"></textarea>
    </div>
    <div class="ctrls">
      <span class="muted" style="font-family:ui-monospace,monospace;font-size:11.5px;letter-spacing:.06em">name will become the project URL slug</span>
      <button class="ans primary" id="next-name" style="padding:10px 18px;border-radius:10px;font-size:14px">
        Next
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><polyline points="13 6 19 12 13 18"/></svg>
      </button>
    </div>
  </div>

  <!-- STEP 1: TYPE + TOOLS -->
  <div id="gate-tools" class="hidden">
    <h2>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6a3d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
      Type &amp; tools
    </h2>
    <div class="meta-row"><span>step 02 &middot; setup</span></div>
    <div class="field">
      <label>Project type</label>
      <div class="chips" id="type-chips"></div>
    </div>
    <div class="field">
      <label>What will you connect?</label>
      <div class="chips" id="tool-chips"></div>
    </div>
    <div class="ctrls">
      <button class="ghost" id="back-name">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Back
      </button>
      <button class="ans primary" id="begin" style="padding:10px 18px;border-radius:10px;font-size:14px">
        Begin wizard
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><polyline points="13 6 19 12 13 18"/></svg>
      </button>
    </div>
  </div>

  <!-- STEP 2: WIZARD -->
  <div id="wiz" class="hidden">
    <h2>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6a3d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 5.6L20 9l-4 3.9.9 5.6L12 16l-4.9 2.5L8 12.9 4 9l5.6-1.4L12 2z"/></svg>
      The wizard
    </h2>
    <div class="progress">
      <span id="pcountW">01 / 15</span>
      <div class="pbar"><i id="pbar"></i></div>
      <span id="pphase" class="muted">shape</span>
    </div>
    <div class="qcard" id="qcard">
      <div>
        <div class="qmeta">
          <span class="tag" id="qtag">product</span>
          <span id="qphase2">shape</span>
        </div>
        <div class="qtext" id="qtext">&nbsp;</div>
        <div class="qhint" id="qhint">&nbsp;</div>
      </div>
      <div class="answers">
        <button class="ans" data-ans="yes">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"/></svg> Yes
        </button>
        <button class="ans" data-ans="no">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg> No
        </button>
        <button class="ans skip" data-ans="skip">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg> Skip
        </button>
        <button class="ans primary" id="ans-gen" disabled>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 11 14 9 22 21 10 13 10 13 2"/></svg> Generate
        </button>
      </div>
    </div>
    <div class="ctrls">
      <button class="ghost" id="back-wiz" disabled>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Back
      </button>
      <span class="muted" id="trail" style="font-family:ui-monospace,monospace;font-size:11.5px;letter-spacing:.06em"></span>
      <button class="ghost" id="restart-wiz">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/></svg> Restart
      </button>
    </div>
    <p class="muted" style="margin-top:14px;font-size:13px">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ff6a3d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:6px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Generate enabled after question 3. Skipped fields use sensible defaults.
    </p>
  </div>

  <!-- GENERATING -->
  <div id="gen-block" class="hidden" style="margin-top:24px">
    <div class="gen"><span class="spin"></span> Building your project plan&hellip;</div>
  </div>

  <!-- RESULT -->
  <div id="result-block" class="hidden" style="margin-top:8px">
    <div class="rule"></div>
    <h2>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"/></svg>
      Your project plan
    </h2>
    <div class="result-card" id="result-card"></div>
    <button class="btn-copy" id="copy-btn">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 17.929H6c-1.105 0-2-.912-2-2.036V5.036C4 3.91 4.895 3 6 3h8c1.105 0 2 .911 2 2.036v1.866m-6 .17h8c1.105 0 2 .91 2 2.035v10.857C20 21.09 19.105 22 18 22h-8c-1.105 0-2-.911-2-2.036V9.107c0-1.124.895-2.036 2-2.036z"/></svg>
      Copy &amp; send to Hub
    </button>
    <button class="btn-edit" id="edit-btn">&#9998; Edit answers</button>
    <p class="muted" style="margin-top:12px;font-size:13px;text-align:center">Paste this in @LabsHubBot chat. Hub creates the project and gives you a dashboard link.</p>
  </div>

  <div class="rule"></div>

  <!-- HISTORY -->
  <h2>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6a3d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/><circle cx="12" cy="12" r="3"/></svg>
    History
  </h2>
  <p class="muted" style="margin-bottom:12px;font-size:13px">Saved in your browser. Each entry holds the full payload, copyable in one tap.</p>
  <div id="history"></div>
  <div class="ctrls" style="margin-top:8px">
    <span class="muted" id="h-count" style="font-family:ui-monospace,monospace;font-size:11.5px;letter-spacing:.06em">0 plans saved</span>
    <button class="ghost" id="clear-hist">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg> Clear
    </button>
  </div>

  <div class="rule"></div>

  <!-- COMING SOON: ANALYZE PRODUCT -->
  <h2>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6a3d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    Coming soon
  </h2>

  <div class="coming-soon">
    <div class="cs-icon">&#128269;</div>
    <div>
      <div class="cs-badge">coming soon</div>
      <div class="cs-title">Analyze Product</div>
      <div class="cs-body">
        Drop a <b>URL or product name</b> and Claude goes and studies it &mdash; reads the landing page, docs, positioning, feature set. Then generates a complete framework for it automatically: name, description, architecture, prompt, full documentation scaffold.<br><br>
        Everything ready to copy into your own project or use as a starting point. No questions, no wizard &mdash; just paste the link, get the full picture.
      </div>
    </div>
  </div>

  <div class="foot">
    <div>hub wizard v0.1</div>
    <div>hub.labs.co</div>
  </div>

</div>
<script>
(function(){
  var tg = window.Telegram && window.Telegram.WebApp;
  if(tg){ tg.ready(); tg.expand(); }

  // Telegram ID from URL
  var tgId = new URLSearchParams(location.search).get('tg') || 'anon';
  var HKEY = 'hub.wizard.v1.' + tgId;

  // ── Data ─────────────────────────────────────────────────────────────────

  var TYPES = [
    {id:'bot',   label:'\u{1F916} Telegram bot'},
    {id:'site',  label:'\u{1F310} Website'},
    {id:'api',   label:'\u{1F517} API service'},
    {id:'mixed', label:'\u26A1 Bot + Site'},
  ];

  var TOOLS = [
    {id:'telegram_bot',  label:'\u{1F916} Bot token',    hint:'need from @BotFather'},
    {id:'openrouter',    label:'\u{1F517} OpenRouter',   hint:'LLM routing'},
    {id:'openai',        label:'\U0001F9E0 OpenAI',       hint:'GPT models'},
    {id:'anthropic',     label:'\u{1F4AB} Anthropic',   hint:'Claude models'},
    {id:'webhook',       label:'\u{1F310} Webhook',      hint:'external endpoint'},
    {id:'github',        label:'\u2665 GitHub',          hint:'repo sync'},
  ];

  var QS = [
    {id:'realtime',   phase:'shape',   text:'Should it respond in real time to user messages?',         hint:'Live bot/chat vs. a static site or batch job.'},
    {id:'ai_core',    phase:'shape',   text:'Is AI the core of the product, not just a nice-to-have?',  hint:'AI-native vs. AI-optional.'},
    {id:'recurring',  phase:'shape',   text:'Will users come back more than once?',                     hint:'Habit-forming vs. one-shot artifact.'},
    {id:'public',     phase:'reach',   text:'Should it be publicly accessible without login?',          hint:'Open URL vs. requires auth.'},
    {id:'viral',      phase:'reach',   text:'Should it be shareable as a single link?',                 hint:'Link-first vs. closed / private.'},
    {id:'minimal',    phase:'feel',    text:'Should the visual style be minimal and dark?',             hint:'Quiet / monochrome vs. expressive / colorful.'},
    {id:'mvp',        phase:'posture', text:'Is speed-to-launch more important than polish?',           hint:'Ship now vs. polish before launch.'},
    {id:'monetized',  phase:'why',     text:'Does it need to make money directly?',                     hint:'Revenue-generating vs. free / brand-building.'},
    {id:'data',       phase:'how',     text:'Does it need to store user data persistently?',            hint:'Stateful (DB) vs. stateless.'},
    {id:'multiuser',  phase:'how',     text:'Will multiple users interact or collaborate?',             hint:'Multi-user / social vs. solo / personal.'},
    {id:'scheduled',  phase:'how',     text:'Should it run on a schedule without manual triggering?',  hint:'Cron / scheduled vs. on-demand only.'},
    {id:'ambitious',  phase:'posture', text:'Should this aim to be a long-term product?',              hint:'Multi-year arc vs. weekend experiment.'},
    {id:'novel',      phase:'posture', text:'Should the core idea feel genuinely novel?',              hint:'Novel / boundary-pushing vs. proven / familiar.'},
    {id:'open_src',   phase:'posture', text:'Should it be open source?',                               hint:'MIT license vs. closed.'},
    {id:'analytics',  phase:'posture', text:'Should it ship with analytics from day one?',             hint:'Tracked / measured vs. no analytics.'},
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  var projName = '';
  var projDesc = '';
  var projType = 'bot';
  var tools    = [];
  var answers  = {};
  var idx      = 0;
  var lastPayload = null;

  // ── Utils ─────────────────────────────────────────────────────────────────
  var $ = function(id){ return document.getElementById(id); };
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function slugify(s){ return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40); }

  // ── Step 0: Name ────────────────────────────────────────────────────────
  $('projName').addEventListener('input', function(){
    this.value = slugify(this.value.replace(/-$/,this.value.endsWith('-')?'-':''));
  });
  $('next-name').addEventListener('click', function(){
    var name = $('projName').value.trim();
    var desc = $('projDesc').value.trim();
    if(!name){ $('projName').focus(); return; }
    projName = name;
    projDesc = desc;
    $('gate-name').classList.add('hidden');
    $('gate-tools').classList.remove('hidden');
    renderTypeChips();
    renderToolChips();
    scrollTop();
  });

  // ── Step 1: Type + Tools ─────────────────────────────────────────────────
  function renderTypeChips(){
    var host = $('type-chips'); host.innerHTML = '';
    TYPES.forEach(function(t){
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (projType === t.id ? ' on' : '');
      b.textContent = t.label;
      b.addEventListener('click', function(){
        projType = t.id;
        renderTypeChips();
      });
      host.appendChild(b);
    });
  }
  function renderToolChips(){
    var host = $('tool-chips'); host.innerHTML = '';
    TOOLS.forEach(function(t){
      var on = tools.includes(t.id);
      var b  = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (on ? ' on' : '');
      var svg = on
        ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 10 18 20 6"/></svg>'
        : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
      b.innerHTML = svg + ' ' + esc(t.label);
      b.title = t.hint;
      b.addEventListener('click', function(){
        var i = tools.indexOf(t.id);
        if(i >= 0) tools.splice(i,1); else tools.push(t.id);
        renderToolChips();
      });
      host.appendChild(b);
    });
  }
  $('back-name').addEventListener('click', function(){
    $('gate-tools').classList.add('hidden');
    $('gate-name').classList.remove('hidden');
    scrollTop();
  });
  $('begin').addEventListener('click', function(){
    $('gate-tools').classList.add('hidden');
    $('wiz').classList.remove('hidden');
    idx = 0; answers = {};
    render();
    scrollTop();
  });

  // ── Wizard ───────────────────────────────────────────────────────────────
  function setProgress(){
    var n = idx + 1;
    $('pcountW').textContent = String(n).padStart(2,'0') + ' / ' + QS.length;
    $('pbar').style.width = (idx / QS.length * 100) + '%';
    $('pphase').textContent = QS[idx].phase;
    $('pphase2') && ($('pphase2').textContent = QS[idx].phase);
    $('ans-gen').disabled = (n < 4);
  }
  function render(){
    setProgress();
    var q = QS[idx];
    var card = $('qcard');
    card.classList.add('fading');
    setTimeout(function(){
      $('qtag').textContent = q.id.replace(/_/g,' ');
      $('qtext').textContent = q.text;
      $('qhint').textContent = q.hint;
      $('back-wiz').disabled = idx === 0;
      var trail = QS.slice(0,idx).map(function(qq){
        var a = answers[qq.id]; return a ? a.raw[0].toUpperCase() : '\u2022';
      }).join(' ');
      $('trail').textContent = trail;
      card.classList.remove('fading');
    }, 140);
  }
  function answer(raw){
    var q = QS[idx];
    answers[q.id] = {val: raw === 'yes' ? 'yes' : raw === 'no' ? 'no' : 'auto', raw: raw};
    if(idx < QS.length - 1){ idx++; render(); }
    else { $('pbar').style.width = '100%'; $('pcountW').textContent = QS.length + ' / ' + QS.length; finish(); }
  }
  function back(){ if(idx === 0) return; idx--; delete answers[QS[idx].id]; render(); }
  function restart(){
    idx = 0; answers = [];
    $('wiz').classList.add('hidden');
    $('gen-block').classList.add('hidden');
    $('result-block').classList.add('hidden');
    $('gate-name').classList.remove('hidden');
    $('projName').value = ''; $('projDesc').value = '';
    tools = []; projType = 'bot';
    scrollTop();
  }

  document.querySelectorAll('button[data-ans]').forEach(function(b){
    b.addEventListener('click', function(){
      if($('wiz').classList.contains('hidden')) return;
      answer(b.dataset.ans);
    });
  });
  $('ans-gen').addEventListener('click', function(){
    if($('ans-gen').disabled) return;
    finish();
  });
  $('back-wiz').addEventListener('click', back);
  $('restart-wiz').addEventListener('click', restart);
  $('edit-btn').addEventListener('click', function(){
    $('result-block').classList.add('hidden');
    $('wiz').classList.remove('hidden');
    idx = 0;
    render();
    scrollTop();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e){
    if($('wiz').classList.contains('hidden')) return;
    if(e.key === '1' || e.key.toLowerCase() === 'y') answer('yes');
    else if(e.key === '2' || e.key.toLowerCase() === 'n') answer('no');
    else if(e.key === '3' || e.key.toLowerCase() === 's') answer('skip');
    else if((e.key === '4' || e.key.toLowerCase() === 'g') && !$('ans-gen').disabled) finish();
    else if(e.key === 'Backspace' || e.key === 'ArrowLeft') back();
  });

  // ── Generate ─────────────────────────────────────────────────────────────
  function finish(){
    $('wiz').classList.add('hidden');
    $('gen-block').classList.remove('hidden');
    setTimeout(function(){
      var payload = buildPayload();
      lastPayload = payload;
      $('gen-block').classList.add('hidden');
      renderResult(payload);
      pushHist(payload);
      $('result-block').classList.remove('hidden');
      $('result-block').scrollIntoView({behavior:'smooth', block:'start'});
    }, 900);
  }

  function buildPayload(){
    // Infer needs from tools + questions
    var needs = tools.slice();
    // If type is bot and no bot_token, suggest it
    if((projType === 'bot' || projType === 'mixed') && !needs.includes('telegram_bot'))
      needs.push('telegram_bot');
    // Infer from questions
    if(answers['ai_core'] && answers['ai_core'].val === 'yes' && !needs.includes('openrouter') && !needs.includes('openai') && !needs.includes('anthropic'))
      needs.push('openrouter');
    // Map tool IDs to need keys
    var toolToNeed = {
      telegram_bot: 'bot_token',
      openrouter:   'openrouter_key',
      openai:       'openai_key',
      anthropic:    'anthropic_key',
      webhook:      'webhook_url',
      github:       'github_repo',
    };
    var needKeys = needs.map(function(t){ return toolToNeed[t] || t; });
    // Build description_long from answers
    var traits = [];
    if(answers['realtime']  && answers['realtime'].val === 'yes')   traits.push('responds in real time');
    if(answers['ai_core']   && answers['ai_core'].val === 'yes')    traits.push('AI-native');
    if(answers['recurring'] && answers['recurring'].val === 'yes')  traits.push('habit-forming');
    if(answers['public']    && answers['public'].val === 'yes')     traits.push('publicly accessible');
    if(answers['mvp']       && answers['mvp'].val === 'yes')        traits.push('ships fast, iterates later');
    if(answers['minimal']   && answers['minimal'].val === 'yes')    traits.push('minimal dark aesthetic');
    if(answers['scheduled'] && answers['scheduled'].val === 'yes')  traits.push('runs on a schedule');
    if(answers['monetized'] && answers['monetized'].val === 'yes')  traits.push('monetized');
    var descLong = projDesc + (traits.length ? ' (' + traits.join(', ') + ').' : '.');
    return {
      hub_wizard:       true,
      name:             projName,
      description:      projDesc || projName,
      description_long: descLong,
      type:             projType,
      needs:            needKeys,
      profile: (function(){
        var p = {};
        QS.forEach(function(q){ p[q.id] = (answers[q.id] && answers[q.id].val) || 'auto'; });
        return p;
      })()
    };
  }

  function renderResult(pl){
    var toolLabels = {
      bot_token:'Bot token', openrouter_key:'OpenRouter key', openai_key:'OpenAI key',
      anthropic_key:'Anthropic key', webhook_url:'Webhook URL', github_repo:'GitHub repo',
    };
    var html = '<h3>' + esc(pl.name) + '</h3>';
    html += '<div class="result-row"><span class="result-k">type</span><span class="result-v">' + esc(pl.type) + '</span></div>';
    html += '<div class="result-row"><span class="result-k">description</span><span class="result-v">' + esc(pl.description) + '</span></div>';
    if(pl.needs.length){
      html += '<div class="result-row"><span class="result-k">needs</span><span class="result-v"><div class="needs-list">';
      pl.needs.forEach(function(n){
        html += '<span class="need-tag">' + esc(toolLabels[n]||n) + '</span>';
      });
      html += '</div></span></div>';
    }
    $('result-card').innerHTML = html;
  }

  // ── Copy ─────────────────────────────────────────────────────────────────
  $('copy-btn').addEventListener('click', function(){
    if(!lastPayload) return;
    var text = JSON.stringify(lastPayload);
    var btn  = $('copy-btn');
    // Try Telegram sendData first (closes WebApp and sends to bot)
    if(tg && tg.sendData){
      try {
        tg.sendData(text);
        return; // WebApp closes, bot receives data
      } catch(e){}
    }
    // Fallback: clipboard
    if(navigator.clipboard){
      navigator.clipboard.writeText(text).then(function(){
        btn.innerHTML = '\u2713 Copied! Paste into @LabsHubBot';
        btn.style.background = '#22c55e';
        setTimeout(function(){
          btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 17.929H6c-1.105 0-2-.912-2-2.036V5.036C4 3.91 4.895 3 6 3h8c1.105 0 2 .911 2 2.036v1.866m-6 .17h8c1.105 0 2 .91 2 2.035v10.857C20 21.09 19.105 22 18 22h-8c-1.105 0-2-.911-2-2.036V9.107c0-1.124.895-2.036 2-2.036z"/></svg> Copy &amp; send to Hub';
          btn.style.background = '#ff6a3d';
        }, 2200);
        if(tg && tg.close) setTimeout(function(){ tg.close(); }, 1400);
      });
    }
  });

  // ── History ───────────────────────────────────────────────────────────────
  function loadHist(){ try{ return JSON.parse(localStorage.getItem(HKEY)||'[]'); }catch(e){ return []; } }
  function saveHist(h){ try{ localStorage.setItem(HKEY, JSON.stringify(h)); }catch(e){} }
  function pushHist(pl){
    var h = loadHist();
    h.unshift({ts: Date.now(), name: pl.name, type: pl.type, needs: pl.needs.length, payload: JSON.stringify(pl)});
    if(h.length > 30) h.length = 30;
    saveHist(h); renderHist();
  }
  function renderHist(){
    var h = loadHist();
    var host = $('history'); host.innerHTML = '';
    $('h-count').textContent = h.length + ' plan' + (h.length===1?'':'s') + ' saved';
    if(!h.length){
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No plans yet. Complete the wizard and hit Generate.';
      host.appendChild(empty); return;
    }
    h.forEach(function(e, i){
      var item = document.createElement('div');
      item.className = 'h-item';
      var date = new Date(e.ts).toLocaleString();
      item.innerHTML = '<div class="h-main">'
        + '<div class="h-row1">'
        + '<span class="badge accent">' + esc(e.type) + '</span>'
        + '<span class="badge">' + (e.needs||0) + ' needs</span>'
        + '<span>' + date + '</span>'
        + '</div>'
        + '<div class="h-summary">' + esc(e.name) + '</div>'
        + '</div>'
        + '<div class="h-actions">'
        + '<button class="icon-btn" data-act="copy" data-i="' + i + '">'
        + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg> Copy</button>'
        + '<button class="icon-btn danger" data-act="del" data-i="' + i + '">'
        + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>'
        + '</div>';
      host.appendChild(item);
    });
    host.querySelectorAll('button[data-act]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var act = btn.dataset.act;
        var i   = parseInt(btn.dataset.i, 10);
        var h2  = loadHist();
        var e   = h2[i]; if(!e) return;
        if(act === 'copy'){
          navigator.clipboard && navigator.clipboard.writeText(e.payload).then(function(){
            var orig = btn.innerHTML;
            btn.innerHTML = '\u2713 Copied';
            setTimeout(function(){ btn.innerHTML = orig; }, 1400);
          });
        } else if(act === 'del'){
          h2.splice(i,1); saveHist(h2); renderHist();
        }
      });
    });
  }
  $('clear-hist').addEventListener('click', function(){
    if(confirm('Clear all saved plans?')){ saveHist([]); renderHist(); }
  });

  function scrollTop(){ window.scrollTo({top:0, behavior:'smooth'}); }

  // ── Boot ─────────────────────────────────────────────────────────────────
  renderHist();

})();
</script>
</body></html>`;

// ── Module contract ─────────────────────────────────────────────────────────

export async function init(ctx) {
  _ctx = ctx;
  ctx.logger.info('[wizard] ready');
}

export function mountRoutes(app, ctx) {
  _ctx = ctx;

  app.get('/hub/wizard', (req, res) => {
    res.type('html').send(renderWizardHTML());
  });

  ctx.logger.info('[wizard] mounted /hub/wizard');
}
