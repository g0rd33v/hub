// hub/server.js — Hub v0.2 kernel
// Single entry point. Loads modules in dependency order, mounts routes,
// starts Express listener.
//
// Architecture principle: this file stays small and dumb about content.
// Everything interesting lives in modules/.

import express from 'express';
import { config, paths } from './config.js';
import { logger }        from './logger.js';
import { loadServerSAP, mountSigninRoutes } from './credentials.js';

// Load SAP before anything else.
loadServerSAP(paths);

const modules = {};
const ctx = { config, paths, logger, modules };

// ─── Module boot ─────────────────────────────────────────────────────────────
// Load order matters: buffer first (state), then runtime (sandbox),
// then drafts (uses both), then telegram (uses drafts state),
// then analytics (uses drafts state).

if (config.modules.buffer) {
  const mod = await import('../modules/buffer/index.js');
  modules.buffer = mod;
  await mod.init(ctx);
  logger.info('module loaded: buffer');
}

if (config.modules.runtime) {
  const mod = await import('../modules/runtime/index.js');
  modules.runtime = mod;
  await mod.init(ctx);
  logger.info('module loaded: runtime');
}

if (config.modules.drafts) {
  const mod = await import('../modules/drafts/index.js');
  modules.drafts = mod;
  await mod.init(ctx);
  logger.info('module loaded: drafts');
}

if (config.modules.telegram) {
  const mod = await import('../modules/telegram/index.js');
  modules.telegram = mod;
  await mod.init(ctx);
  logger.info('module loaded: telegram');
}

if (config.modules.analytics) {
  const mod = await import('../modules/analytics/index.js');
  modules.analytics = mod;
  await mod.init(ctx);
  logger.info('module loaded: analytics');
}

if (config.modules.wizard) {
  const mod = await import('../modules/wizard/index.js');
  modules.wizard = mod;
  await mod.init(ctx);
  logger.info('module loaded: wizard');
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

// Health — kernel-level, always responds regardless of module state.
app.get('/health', (req, res) => res.json({
  ok:            true,
  version:       '0.2.0',
  server_number: config.serverNumber,
  modules:       Object.keys(modules),
  uptime_sec:    Math.floor(process.uptime()),
}));


//  Public landing pages 

const LANDING_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hub &middot; hub.labs.co</title>
<meta name="description" content="Run bots, sites and APIs from one place. Manage everything from the dashboard.">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#000;color:#f0f0f0;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh}
.wrap{max-width:680px;margin:0 auto;padding:72px 24px 96px}
.eyebrow{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#555;margin-bottom:24px;display:flex;align-items:center;gap:8px}
.dot{width:7px;height:7px;border-radius:50%;background:#ff6a3d;box-shadow:0 0 14px rgba(255,106,61,.5)}
h1{font-size:52px;font-weight:800;letter-spacing:-.03em;line-height:1.05;margin-bottom:18px}
h1 span{color:#ff6a3d}
.lead{font-size:17px;color:#888;line-height:1.6;max-width:520px;margin-bottom:48px}
.cta{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#000;font-weight:700;font-size:15px;padding:14px 24px;border-radius:10px;text-decoration:none;transition:opacity .12s}
.cta:hover{opacity:.88}
.cta svg{flex-shrink:0}
.divider{height:1px;background:rgba(255,255,255,.07);margin:56px 0}
.steps{display:grid;gap:20px}
.step{display:grid;grid-template-columns:28px 1fr;gap:14px;align-items:start}
.step-n{font-family:ui-monospace,monospace;font-size:11px;color:#ff6a3d;font-weight:700;padding-top:3px}
.step-t{font-size:15px;font-weight:600;color:#f0f0f0;margin-bottom:3px}
.step-d{font-size:13px;color:#555;line-height:1.5}
code{font-family:ui-monospace,monospace;font-size:12px;background:rgba(255,255,255,.06);padding:1px 6px;border-radius:3px;color:#ccc}
.foot{margin-top:64px;font-family:ui-monospace,monospace;font-size:11px;color:#333;letter-spacing:.04em}
@media(max-width:500px){h1{font-size:36px}.wrap{padding:48px 18px 80px}}
</style>
</head><body>
<div class="wrap">
  <div class="eyebrow"><span class="dot"></span> HUB &middot; LABS.CO</div>
  <h1>Run bots, sites<br>and APIs.<br><span>From one place.</span></h1>
  <p class="lead">Connect a Telegram bot token once. Everything else &mdash; dashboard, broadcast, commands, profile, webhook &mdash; managed from here.</p>
  <a class="cta" href="https://t.me/LabsHubBot" target="_blank" rel="noopener">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 2L15 22 11 13 2 9l20-7z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Open @LabsHubBot
  </a>
  <div class="divider"></div>
  <div class="steps">
    <div class="step"><div class="step-n">01</div><div><div class="step-t">Send your bot token</div><div class="step-d">Get a token from @BotFather. Send it to @LabsHubBot. Your project is created instantly.</div></div></div>
    <div class="step"><div class="step-n">02</div><div><div class="step-t">Get your dashboard link</div><div class="step-d">Hub sends back a PAP link &mdash; your private dashboard. Open it in Claude for Chrome to build the project, or manage it directly from the web.</div></div></div>
    <div class="step"><div class="step-n">03</div><div><div class="step-t">Manage everything from the dashboard</div><div class="step-d">Broadcast to all subscribers. Send to a specific user. Edit commands, bot name, description. Switch between polling and webhook. One dashboard, full control.</div></div></div>
  </div>
  <div class="foot">hub.labs.co &middot; powered by Labs</div>
</div>
</body></html>`;

app.get('/', (req, res) => res.type('html').send(LANDING_HTML));
app.get('/telegram', (req, res) => res.redirect(301, 'https://t.me/LabsHubBot'));

// Signin — kernel owns the URL, delegates rendering to drafts module.
mountSigninRoutes(app, ctx);

// Module routes.
for (const [name, mod] of Object.entries(modules)) {
  if (typeof mod.mountRoutes === 'function') {
    mod.mountRoutes(app, ctx);
    logger.info(`mounted routes: ${name}`);
  }
}

// Drafts project middleware — must come last (catch-all for /<project>/*).
if (modules.drafts && typeof modules.drafts.mountProjectMiddleware === 'function') {
  modules.drafts.mountProjectMiddleware(app, ctx);
}

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(config.port, '127.0.0.1', () => {
  logger.info(`Hub v0.2.0 on 127.0.0.1:${config.port}`);
  logger.info(`public_base: ${config.publicBase}`);
  logger.info(`server_number: ${config.serverNumber}`);
  logger.info(`modules: ${Object.keys(modules).join(', ')}`);
});
