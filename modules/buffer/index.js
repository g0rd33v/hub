// modules/buffer/index.js — Hub Buffer
// Personal store per Telegram user. Server-side SQLite, cross-device by design.
// Every non-command message in @LabsHubBot is auto-saved.
//
// Routes:
//   GET  /buffer/:telegramId        — JSON feed (API)
//   GET  /hub/buffer?tg={id}        — browser/Telegram webapp
//   POST /hub/buffer/clear?tg={id}  — clear buffer (used by webapp)

import fs       from 'fs';
import path     from 'path';
import Database from 'better-sqlite3';

const BUFFER_MAX      = 200;
const ENTRY_MAX_BYTES = 8192;

const cache = new Map();

// ── Storage ────────────────────────────────────────────────────────────────────

function dbPath(dataDir, telegramId) {
  const dir = path.join(dataDir, 'buffer');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(telegramId)}.db`);
}

function openDb(dataDir, telegramId) {
  const key = `buf:${telegramId}`;
  if (cache.has(key)) return cache.get(key);
  const db = new Database(dbPath(dataDir, telegramId));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      text      TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      kind      TEXT NOT NULL DEFAULT 'text'
    );
    CREATE INDEX IF NOT EXISTS idx_buf_ts ON entries(ts DESC);
  `);
  const stmts = {
    add:   db.prepare('INSERT INTO entries(text, ts, kind) VALUES(?, ?, ?)'),
    list:  db.prepare('SELECT id, text, ts, kind FROM entries ORDER BY ts DESC LIMIT ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM entries'),
    clear: db.prepare('DELETE FROM entries'),
    trim:  db.prepare('DELETE FROM entries WHERE id NOT IN (SELECT id FROM entries ORDER BY ts DESC LIMIT ?)'),
    del1:  db.prepare('DELETE FROM entries WHERE id = ?'),
  };
  const kv = { db, stmts };
  cache.set(key, kv);
  return kv;
}

// ── Public API (used by master.js + routes) ────────────────────────────────────

export function bufferAdd(dataDir, telegramId, text, kind = 'text') {
  try {
    const { stmts } = openDb(dataDir, String(telegramId));
    stmts.add.run(String(text).slice(0, ENTRY_MAX_BYTES), Date.now(), kind);
    stmts.trim.run(BUFFER_MAX);
    return true;
  } catch { return false; }
}

export function bufferList(dataDir, telegramId, limit = 50) {
  try {
    return openDb(dataDir, String(telegramId)).stmts.list.all(Math.min(limit, 200));
  } catch { return []; }
}

export function bufferCount(dataDir, telegramId) {
  try {
    return openDb(dataDir, String(telegramId)).stmts.count.get()?.n || 0;
  } catch { return 0; }
}

export function bufferClear(dataDir, telegramId) {
  try {
    openDb(dataDir, String(telegramId)).stmts.clear.run();
    // Invalidate cache so next openDb gets fresh state
    cache.delete(`buf:${telegramId}`);
    return true;
  } catch { return false; }
}

// ── KV store (existing, used by sandbox/runtime) ───────────────────────────────

const KV_MAX_KEY_LEN = 512;

function openKv(dataDir, projectName) {
  const key = `kv:${projectName}`;
  if (cache.has(key)) return cache.get(key);
  const dir = path.join(dataDir, 'buffer');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, `${projectName}.kv.db`));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      k          TEXT PRIMARY KEY,
      v          BLOB NOT NULL,
      expires_at INTEGER,
      bytes      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kv_prefix ON kv(k);
    CREATE INDEX IF NOT EXISTS idx_kv_expiry ON kv(expires_at) WHERE expires_at IS NOT NULL;
  `);
  const stmts = {
    get:      db.prepare('SELECT v, expires_at FROM kv WHERE k = ?'),
    set:      db.prepare('INSERT OR REPLACE INTO kv(k, v, expires_at, bytes) VALUES(?, ?, ?, ?)'),
    del:      db.prepare('DELETE FROM kv WHERE k = ?'),
    list:     db.prepare('SELECT k, v, expires_at FROM kv WHERE k LIKE ? ORDER BY k LIMIT 1000'),
    sumBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS total FROM kv'),
  };
  function checkKey(k) {
    if (typeof k !== 'string' || !k.length) throw new Error('kv: key must be non-empty string');
    if (k.length > KV_MAX_KEY_LEN) throw new Error('kv: key too long');
  }
  function maybeExpired(row, k) {
    if (!row) return null;
    if (row.expires_at && row.expires_at <= Date.now()) { stmts.del.run(k); return null; }
    return row;
  }
  function decodeValue(blob) {
    try { return JSON.parse(blob.toString('utf8')); } catch { return null; }
  }
  const kv = {
    get(k)            { checkKey(k); const row = maybeExpired(stmts.get.get(k), k); return row ? decodeValue(row.v) : null; },
    set(k, val, ttl)  { checkKey(k); const buf = Buffer.from(JSON.stringify(val), 'utf8'); stmts.set.run(k, buf, ttl ? Date.now()+ttl : null, buf.length); },
    del(k)            { checkKey(k); stmts.del.run(k); },
    list(prefix = '') { return stmts.list.all(prefix + '%').filter(r => maybeExpired(r, r.k)).map(r => ({ k: r.k, v: decodeValue(r.v) })); },
    bytes()           { return stmts.sumBytes.get().total; },
    _internal: { db },
  };
  cache.set(key, kv);
  return kv;
}

// ── Buffer Webapp HTML ─────────────────────────────────────────────────────────

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#000;color:#f0f0f0;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:#60a5fa;text-decoration:none}
#app{max-width:680px;margin:0 auto;padding:40px 18px 80px}
.eyebrow{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#555;margin-bottom:20px;display:flex;align-items:center;gap:8px}
.dot{width:7px;height:7px;border-radius:50%;background:#ff6a3d;box-shadow:0 0 14px rgba(255,106,61,.5)}
h1{font-size:28px;font-weight:800;letter-spacing:-.02em;margin-bottom:4px}
.lead{font-size:13px;color:#555;margin-bottom:4px}
.stats{font-family:ui-monospace,monospace;font-size:11px;color:#444;margin-bottom:20px;letter-spacing:.04em}
.divider{height:1px;background:rgba(255,255,255,.07);margin:18px 0}
.entry{border:1px solid rgba(255,255,255,.07);border-radius:10px;padding:13px 14px;margin-bottom:8px;background:rgba(255,255,255,.02);transition:border-color .12s;cursor:default}
.entry:hover{border-color:rgba(255,255,255,.14)}
.entry-meta{font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#444;margin-bottom:6px;display:flex;justify-content:space-between}
.entry-text{font-size:13.5px;color:#d0d0d0;line-height:1.55;word-break:break-word;white-space:pre-wrap}
.entry-text a{color:#60a5fa}
.tag{display:inline-block;font-family:ui-monospace,monospace;font-size:10px;padding:1px 6px;border-radius:3px;border:1px solid rgba(255,255,255,.1);color:#666;margin-left:8px}
.controls{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}
.btn{font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:transparent;color:#888;cursor:pointer;font-family:inherit;transition:all .12s;white-space:nowrap}
.btn:hover{color:#f0f0f0;border-color:rgba(255,255,255,.25)}
.btn-danger{border-color:rgba(248,113,113,.25);color:#f87171}
.btn-danger:hover{background:rgba(248,113,113,.08);border-color:rgba(248,113,113,.5)}
.btn-copy{border-color:rgba(96,165,250,.25);color:#60a5fa}
.btn-copy:hover{background:rgba(96,165,250,.08);border-color:rgba(96,165,250,.5)}
.empty{color:#333;font-size:13px;text-align:center;padding:40px 0;font-family:ui-monospace,monospace;letter-spacing:.04em}
.search-row{margin-bottom:14px}
.search-row input{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);color:#f0f0f0;padding:9px 12px;border-radius:8px;font-family:inherit;font-size:13px;outline:none}
.search-row input:focus{border-color:rgba(255,255,255,.22)}
.feed-url{font-family:ui-monospace,monospace;font-size:11px;color:#444;padding:8px 12px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:6px;overflow-x:auto;white-space:nowrap;margin-top:12px}
footer{position:fixed;bottom:0;left:0;right:0;background:#000;border-top:1px solid rgba(255,255,255,.06);padding:10px 18px;font-family:ui-monospace,monospace;font-size:10px;color:#222;text-align:center;letter-spacing:.04em}
#toast{position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.92);border:1px solid rgba(255,255,255,.15);color:#f0f0f0;padding:7px 16px;border-radius:20px;font-size:13px;pointer-events:none;opacity:0;transition:opacity .18s;z-index:999;white-space:nowrap}
#toast.show{opacity:1}
.spinner{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.15);border-top-color:#ff6a3d;border-radius:50%;animation:spin .7s linear infinite;margin-right:6px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:500px){#app{padding:28px 14px 80px}h1{font-size:22px}}
`;

function renderBufferHtml(tgId, base) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Buffer \u2014 Hub</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>${CSS}</style>
</head><body>
<div id="app">
  <div class="eyebrow"><span class="dot"></span> HUB &middot; BUFFER</div>
  <h1>Your buffer.</h1>
  <p class="lead">Everything you send to @LabsHubBot is saved here. Cross-device &mdash; same link everywhere.</p>
  <div class="stats" id="stats">Loading&hellip;</div>
  <div class="controls">
    <button class="btn btn-copy" id="copyLinkBtn">&#128279; Copy link</button>
    <button class="btn btn-danger" id="clearBtn">&#128465; Clear buffer</button>
  </div>
  <div class="search-row"><input type="text" id="search" placeholder="Search your buffer\u2026"></div>
  <div class="divider"></div>
  <div id="entries"><div class="empty"><span class="spinner"></span></div></div>
  <div class="feed-url" id="feedUrl"></div>
</div>
<footer>buffer &middot; hub.labs.co &middot; stored server-side by Telegram ID</footer>
<div id="toast"></div>
<script>
(function(){
  var tg  = window.Telegram && window.Telegram.WebApp;
  if(tg){ tg.ready(); tg.expand(); }

  var TG_ID = ${JSON.stringify(tgId)};
  var BASE  = ${JSON.stringify(base)};
  var FEED  = BASE + '/buffer/' + TG_ID;
  var CLEAR = BASE + '/hub/buffer/clear?tg=' + TG_ID;

  var allEntries = [];
  var toast = document.getElementById('toast');
  var toastTimer;

  function showToast(msg){
    toast.textContent = msg;
    toast.className = 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toast.className = ''; }, 2200);
  }

  function timeAgo(ts){
    var d = Date.now() - ts;
    if(d < 60000)    return Math.floor(d/1000) + 's ago';
    if(d < 3600000)  return Math.floor(d/60000) + 'm ago';
    if(d < 86400000) return Math.floor(d/3600000) + 'h ago';
    return Math.floor(d/86400000) + 'd ago';
  }

  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Linkify URLs in text
  function linkify(s){
    return esc(s).replace(/https?:\\/\\/[^\\s<>"]+/g, function(url){
      return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a>';
    });
  }

  function render(entries){
    var host = document.getElementById('entries');
    if(!entries.length){
      host.innerHTML = '<div class="empty">Buffer is empty. Anything you send to @LabsHubBot lands here.</div>';
      return;
    }
    host.innerHTML = entries.map(function(e){
      return '<div class="entry" data-id="' + e.id + '">' +
        '<div class="entry-meta"><span>' + timeAgo(e.ts) + '</span><span>' +
        new Date(e.ts).toLocaleString() +
        (e.kind !== 'text' ? '<span class="tag">' + esc(e.kind) + '</span>' : '') +
        '</span></div>' +
        '<div class="entry-text">' + linkify(e.text) + '</div>' +
        '</div>';
    }).join('');
  }

  function load(){
    fetch(FEED + '?limit=200').then(function(r){ return r.json(); }).then(function(data){
      if(!data.ok) throw new Error(data.error);
      allEntries = data.entries || [];
      var total = data.count || allEntries.length;
      document.getElementById('stats').textContent = total + ' item' + (total !== 1 ? 's' : '') + ' \u00b7 auto-saved from @LabsHubBot';
      render(allEntries);
      document.getElementById('feedUrl').textContent = FEED;
    }).catch(function(e){
      document.getElementById('entries').innerHTML = '<div class="empty">Could not load buffer: ' + esc(e.message) + '</div>';
      document.getElementById('stats').textContent = 'Error loading';
    });
  }

  // Search
  document.getElementById('search').addEventListener('input', function(){
    var q = this.value.trim().toLowerCase();
    if(!q){ render(allEntries); return; }
    render(allEntries.filter(function(e){ return e.text.toLowerCase().includes(q); }));
  });

  // Copy link
  document.getElementById('copyLinkBtn').addEventListener('click', function(){
    var url = BASE + '/hub/buffer?tg=' + TG_ID;
    if(navigator.clipboard){
      navigator.clipboard.writeText(url).then(function(){ showToast('\u2713 Link copied'); });
    } else {
      showToast(url);
    }
  });

  // Clear
  document.getElementById('clearBtn').addEventListener('click', function(){
    if(!confirm('Clear all ' + allEntries.length + ' items? This cannot be undone.')) return;
    fetch(CLEAR, { method: 'POST' }).then(function(r){ return r.json(); }).then(function(data){
      if(data.ok){
        allEntries = [];
        render([]);
        document.getElementById('stats').textContent = '0 items';
        showToast('\u2713 Buffer cleared');
      } else {
        showToast('Failed: ' + data.error);
      }
    }).catch(function(e){ showToast('Error: ' + e.message); });
  });

  // Auto-refresh every 30s
  setInterval(load, 30000);

  load();
})();
</script>
</body></html>`;
}

// ── Module contract ────────────────────────────────────────────────────────────

let _ctx;

export async function init(ctx) {
  _ctx = ctx;
  ctx.logger.info('[buffer] ready');
}

export function getKv(projectName) {
  return openKv(_ctx.config.dataDir, projectName);
}

export function mountRoutes(app, ctx) {
  _ctx = ctx;
  const base = ctx.config.publicBase;

  // Webapp: GET /hub/buffer?tg={id}
  app.get('/hub/buffer', (req, res) => {
    const tgId = String(req.query.tg || '').replace(/[^0-9]/g, '');
    if (!tgId) {
      res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Buffer</title></head><body style="background:#000;color:#888;font-family:monospace;padding:40px">
        No Telegram ID provided. Open this link from @LabsHubBot: /buffer command.
      </body></html>`);
      return;
    }
    res.type('html').send(renderBufferHtml(tgId, base));
  });

  // Clear: POST /hub/buffer/clear?tg={id}
  app.post('/hub/buffer/clear', (req, res) => {
    const tgId = String(req.query.tg || '').replace(/[^0-9]/g, '');
    if (!tgId) return res.status(400).json({ ok: false, error: 'missing tg' });
    const ok = bufferClear(ctx.config.dataDir, tgId);
    res.json({ ok });
  });

  // JSON feed: GET /buffer/:telegramId
  app.get('/buffer/:telegramId', (req, res) => {
    const id    = String(req.params.telegramId).replace(/[^0-9a-zA-Z_-]/g, '');
    if (!id) return res.status(400).json({ ok: false, error: 'invalid_id' });
    const limit   = Math.min(parseInt(req.query.limit) || 50, 200);
    const entries = bufferList(ctx.config.dataDir, id, limit);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok:      true,
      id,
      count:   entries.length,
      entries: entries.map(e => ({
        id:   e.id,
        text: e.text,
        ts:   e.ts,
        kind: e.kind,
        date: new Date(e.ts).toISOString(),
      })),
    });
  });

  ctx.logger.info('[buffer] mounted /hub/buffer + /buffer/:telegramId');
}
