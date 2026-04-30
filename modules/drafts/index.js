// modules/drafts/index.js — drafts module coordinator
//
// Exports:
//   mountRoutes(app, ctx)         — /drafts/* admin API + /hub/state + /hub/webapp
//   mountProjectMiddleware(app)   — catch-all /<project>/* serving
//   handleSignin(req, res, opts)  — used by credentials.js signin route

export * from './http.js';
export * from './state.js';
export * from './projects.js';
export * from './static.js';

import * as httpApi     from './http.js';
import * as staticServe from './static.js';
import * as webApp      from './webapp.js';

export function mountRoutes(app, ctx) {
  httpApi.mountRoutes(app, ctx);
  mountWebAppRoutes(app, ctx);
}

function mountWebAppRoutes(app, ctx) {
  // GET /hub/state?token=... — Mini App state API
  app.get('/hub/state', async (req, res) => {
    try { await webApp.handleState(req, res, ctx); }
    catch(e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // GET /hub/webapp?token=... — Mini App HTML shell
  app.get('/hub/webapp', (req, res) => {
    try { webApp.handleWebApp(req, res, ctx); }
    catch(e) { res.status(500).send('Error: '+e.message); }
  });

  // PUT /drafts/project/webhook — enable webhook mode
  app.put('/drafts/project/webhook', async (req, res) => {
    try { await webApp.handleWebhookEnable(req, res, ctx); }
    catch(e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // DELETE /drafts/project/webhook — back to polling
  app.delete('/drafts/project/webhook', async (req, res) => {
    try { await webApp.handleWebhookDisable(req, res, ctx); }
    catch(e) { res.status(500).json({ ok:false, error:e.message }); }
  });

  // GET /drafts/project/analytics
  app.get('/drafts/project/analytics', async (req, res) => {
    try { await webApp.handleAnalytics(req, res, ctx); }
    catch(e) { res.status(500).json({ ok:false, error:e.message }); }
  });
}

export function mountProjectMiddleware(app, ctx) {
  staticServe.mountProjectMiddleware(app, ctx);
}
