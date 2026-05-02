// Secret status page — /status/x7k2m9p4nq8v
// Shows real-time health of prod + stage, all modules, versions, uptime

export const STATUS_SLUG = 'x7k2m9p4nq8v';

export const STATUS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Hub Status</title>
<style>
  :root {
    --ok: #22c55e;
    --warn: #f59e0b;
    --dead: #ef4444;
    --bg: #000;
    --card: #0f0f0f;
    --border: rgba(255,255,255,0.08);
    --text: #fff;
    --muted: rgba(255,255,255,0.45);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
    min-height: 100vh;
    padding: 24px 16px 48px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 32px;
    flex-wrap: wrap;
    gap: 12px;
  }
  h1 {
    font-size: clamp(22px, 5vw, 32px);
    font-weight: 800;
    letter-spacing: -0.04em;
  }
  h1 span { color: var(--muted); font-weight: 400; font-size: 0.6em; }
  #refresh-badge {
    font-size: 13px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--ok);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%,100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 24px;
  }
  @media (max-width: 480px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px 20px 16px;
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .env-label {
    font-size: clamp(13px, 3vw, 15px);
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .status-badge {
    font-size: clamp(13px, 3vw, 15px);
    font-weight: 700;
    padding: 4px 12px;
    border-radius: 20px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .status-badge.ok { background: rgba(34,197,94,0.15); color: var(--ok); }
  .status-badge.dead { background: rgba(239,68,68,0.15); color: var(--dead); }
  .status-badge.loading { background: rgba(255,255,255,0.05); color: var(--muted); }
  .meta-row {
    display: flex;
    justify-content: space-between;
    font-size: clamp(12px, 2.5vw, 14px);
    color: var(--muted);
    margin-bottom: 14px;
  }
  .meta-row strong { color: var(--text); font-weight: 600; }
  .modules-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .mod {
    font-size: clamp(11px, 2.5vw, 13px);
    padding: 5px 10px;
    border-radius: 8px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .mod.ok { background: rgba(34,197,94,0.1); color: #86efac; border: 1px solid rgba(34,197,94,0.2); }
  .mod.dead { background: rgba(239,68,68,0.1); color: #fca5a5; border: 1px solid rgba(239,68,68,0.2); }
  .section-title {
    font-size: clamp(11px, 2.5vw, 12px);
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 12px;
    margin-top: 20px;
  }
  .infra-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
  }
  .infra-item {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .infra-name { font-size: 13px; font-weight: 700; }
  .infra-val { font-size: 12px; color: var(--muted); }
  .infra-val.ok { color: var(--ok); }
  .infra-val.dead { color: var(--dead); }
  #timestamp {
    text-align: center;
    font-size: 12px;
    color: var(--muted);
    margin-top: 32px;
  }
  .spinner {
    width: 16px; height: 16px;
    border: 2px solid rgba(255,255,255,0.1);
    border-top-color: var(--muted);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    display: inline-block;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .uptime-bar-wrap {
    background: rgba(255,255,255,0.06);
    border-radius: 4px;
    height: 4px;
    margin-top: 10px;
    overflow: hidden;
  }
  .uptime-bar {
    height: 100%;
    border-radius: 4px;
    background: var(--ok);
    transition: width 0.6s ease;
  }
</style>
</head>
<body>
<header>
  <h1>[hub] <span>status</span></h1>
  <div id="refresh-badge"><div id="dot"></div><span id="countdown">updating...</span></div>
</header>

<div class="grid">
  <div class="card" id="card-prod">
    <div class="card-header">
      <span class="env-label">prod</span>
      <span class="status-badge loading" id="badge-prod"><span class="spinner"></span></span>
    </div>
    <div class="meta-row"><span>version</span><strong id="ver-prod">&mdash;</strong></div>
    <div class="meta-row"><span>uptime</span><strong id="uptime-prod">&mdash;</strong></div>
    <div class="meta-row"><span>server</span><strong id="sn-prod">&mdash;</strong></div>
    <div class="uptime-bar-wrap"><div class="uptime-bar" id="bar-prod" style="width:0%"></div></div>
    <div class="section-title" style="margin-top:18px">modules</div>
    <div class="modules-grid" id="mods-prod"></div>
  </div>
  <div class="card" id="card-stage">
    <div class="card-header">
      <span class="env-label">stage</span>
      <span class="status-badge loading" id="badge-stage"><span class="spinner"></span></span>
    </div>
    <div class="meta-row"><span>version</span><strong id="ver-stage">&mdash;</strong></div>
    <div class="meta-row"><span>uptime</span><strong id="uptime-stage">&mdash;</strong></div>
    <div class="meta-row"><span>server</span><strong id="sn-stage">&mdash;</strong></div>
    <div class="uptime-bar-wrap"><div class="uptime-bar" id="bar-stage" style="width:0%"></div></div>
    <div class="section-title" style="margin-top:18px">modules</div>
    <div class="modules-grid" id="mods-stage"></div>
  </div>
</div>

<div class="section-title">infrastructure</div>
<div class="infra-grid" id="infra"></div>

<div id="timestamp"></div>

<script>
const PROD_URL  = '/health';
const STAGE_URL = 'http://localhost:3101/health'; // proxied via backend

async function fetchHealth(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    return { ok: true, latency: Date.now()-t0, ...d };
  } catch(e) {
    return { ok: false, latency: Date.now()-t0, error: e.message };
  }
}

function formatUptime(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec/86400);
  const h = Math.floor((sec%86400)/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec % 60;
  if (d > 0) return d+'d '+h+'h';
  if (h > 0) return h+'h '+m+'m';
  if (m > 0) return m+'m '+s+'s';
  return s+'s';
}

function renderEnv(id, data) {
  const badge = document.getElementById('badge-'+id);
  const isOk = data.ok === true;
  badge.className = 'status-badge ' + (isOk ? 'ok' : 'dead');
  badge.innerHTML = isOk ? '&#10003; online' : '&#10005; offline';

  document.getElementById('ver-'+id).textContent = data.version || '—';
  document.getElementById('uptime-'+id).textContent = formatUptime(data.uptime_sec) + (data.latency ? '  ·  '+data.latency+'ms' : '');
  document.getElementById('sn-'+id).textContent = data.server_number !== undefined ? '#'+data.server_number : '—';

  // uptime bar — cap at 7 days
  const pct = Math.min(100, Math.round((data.uptime_sec || 0) / (7*86400) * 100));
  document.getElementById('bar-'+id).style.width = pct + '%';

  const mods = document.getElementById('mods-'+id);
  mods.innerHTML = '';
  if (data.modules && data.modules.length) {
    data.modules.forEach(m => {
      const el = document.createElement('span');
      el.className = 'mod ok';
      el.textContent = m;
      mods.appendChild(el);
    });
  } else if (!isOk) {
    const el = document.createElement('span');
    el.className = 'mod dead';
    el.textContent = data.error || 'unreachable';
    mods.appendChild(el);
  }
}

async function fetchInfra() {
  try {
    const r = await fetch('/status/x7k2m9p4nq8v/infra', { cache: 'no-store' });
    return await r.json();
  } catch { return null; }
}

function renderInfra(data) {
  if (!data) return;
  const grid = document.getElementById('infra');
  grid.innerHTML = '';
  Object.entries(data).forEach(([k, v]) => {
    const el = document.createElement('div');
    el.className = 'infra-item';
    const isOk = v.ok !== false;
    el.innerHTML = '<div class="infra-name">'+k+'</div><div class="infra-val '+(isOk?'ok':'dead')+'">'+v.label+'</div>';
    grid.appendChild(el);
  });
}

let secs = 15;
function tick() {
  secs--;
  if (secs <= 0) { secs = 15; refresh(); }
  document.getElementById('countdown').textContent = 'next in ' + secs + 's';
}

async function refresh() {
  const [prod, stage, infra] = await Promise.all([
    fetchHealth(PROD_URL),
    fetchHealth('/status/x7k2m9p4nq8v/stage-health'),
    fetchInfra()
  ]);
  renderEnv('prod', prod);
  renderEnv('stage', stage);
  renderInfra(infra);
  document.getElementById('timestamp').textContent =
    'Last updated: ' + new Date().toLocaleTimeString();
}

refresh();
setInterval(tick, 1000);
</script>
</body>
</html>`;
