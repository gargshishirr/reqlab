'use strict';

const path = require('path');
const express = require('express');

const { createAuth } = require('./api/auth');
const { createProxyHandler } = require('./api/proxy');
const { createRouter } = require('./api/routes');
const { rebindingGuard, sameOriginOnly, securityHeaders } = require('./api/security');

const publicDir = path.join(__dirname, '..', 'public');

/**
 * Builds the ReqLab web app (the UI and the API) without starting a server, so tests can run it too.
 * @param {object} config  see config.js
 * @param {object} [deps]  test seams: `fetch` and `lookup` for the proxy, `auth` ({ now, failureDelayMs })
 */
function createApp(config, deps = {}) {
  const auth = createAuth(config, deps.auth);
  const proxyHandler = createProxyHandler(config, deps);

  const app = express();
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(rebindingGuard(config));
  app.use(sameOriginOnly);

  // Sign-in pages, then the gate: with a password set, everything below needs a session. Request bodies
  // are only read after this point, so nobody can make the server parse a large body without signing in.
  app.use(auth.router);
  app.use(auth.requireSignIn);

  // API
  app.use(
    '/api',
    (_req, res, next) => {
      res.set('Cache-Control', 'no-store');
      next();
    },
    express.json({ limit: config.maxBodyBytes }),
    createRouter({ proxyHandler, sessionInfo: auth.sessionInfo })
  );
  app.use('/api', (_req, res) => res.status(404).json({ error: 'endpoint not found' }));
  // Request-body errors (too large, malformed JSON) as JSON, so the UI can show what went wrong.
  app.use('/api', (err, _req, res, next) => {
    if (!err.status || err.status >= 500) return next(err);
    const mb = config.maxBodyBytes / 1048576;
    const limit = mb >= 1 ? `${+mb.toFixed(1)} MB` : `${Math.ceil(config.maxBodyBytes / 1024)} KB`;
    const error =
      err.type === 'entity.too.large'
        ? `The request is too large for this server (the limit is ${limit}).`
        : 'The request could not be read.';
    return res.status(err.status).json({ error });
  });

  // Static website
  app.use(express.static(publicDir));
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  return app;
}

module.exports = { createApp };
