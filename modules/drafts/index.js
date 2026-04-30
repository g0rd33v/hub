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

import * as httpApi    from './http.js';
import * as staticServe from './static.js';
import * as webApp     from './webapp.js';

let _webappMounted = false;

export function mountRoutes(app, ctx) {
  httpApi.mountRoutes(app, ctx);
  // Mount Mini App routes (/hub/state, /hub/webapp) once
  if (!_webappMounted) {
    _webappMounted = true;
    mountWebAppRoutes(app, ctx);
  }
}

function mountWebAppRoutes(app, ctx) {
  // GET /hub/state
  app.get('/hub/state', async (req, res) => {
    await webApp.handleState(req, res, ctx);
  });
  // GET /hub/webapp
  app.get('/hub/webapp', (req, res) => {
    webApp.handleWebApp(req, res, ctx);
  });
  // PUT /drafts/project/webhook
  app.put('/drafts/project/webhook', async (req, res) => {
    await webApp.handleWebhookEnable(req, res, ctx);
  });
  // DELETE /drafts/project/webhook
  app.delete('/drafts/project/webhook', async (req, res) => {
    await webApp.handleWebhookDisable(req, res, ctx);
  });
  // GET /drafts/project/analytics
  app.get('/drafts/project/analytics', async (req, res) => {
    await webApp.handleAnalytics(req, res, ctx);
  });
}

export function mountProjectMiddleware(app, ctx) {
  staticServe.mountProjectMiddleware(app, ctx);
}
