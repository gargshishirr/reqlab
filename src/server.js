'use strict';

const path = require('path');
const http = require('http');
const express = require('express');

const config = require('./config');
const { createProxyHandler } = require('./api/proxy');
const { createRouter } = require('./api/routes');

const proxyHandler = createProxyHandler(config);

const app = express();
const publicDir = path.join(__dirname, '..', 'public');

// Request bodies can be large (uploads / big JSON payloads).
app.use(express.json({ limit: config.maxBodyBytes }));
app.use(express.text({ limit: config.maxBodyBytes, type: 'text/plain' }));

// API
app.use('/api', createRouter({ proxyHandler }));
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

const server = http.createServer(app);

server.listen(config.port, config.host, () => {
  /* eslint-disable no-console */
  console.log('');
  console.log('  ┌───────────────────────────────────────────────┐');
  console.log('  │   ReqLab — lightweight API client              │');
  console.log('  └───────────────────────────────────────────────┘');
  console.log(`  Web UI / API : http://localhost:${config.port}`);
  console.log(`  Proxy        : POST /api/proxy`);
  console.log(`  Storage      : stateless (nothing written to disk)`);
  console.log(
    `  SSRF guard   : ${config.blockPrivateHosts ? 'ON (private hosts blocked)' : 'off'}`
  );
  const limits = [
    config.rateLimitPerMinute && `${config.rateLimitPerMinute}/min per visitor`,
    config.rateLimitTotalPerMinute && `${config.rateLimitTotalPerMinute}/min in total`,
  ].filter(Boolean);
  console.log(`  Rate limit   : ${limits.length ? limits.join(', ') : 'off'}`);
  console.log(
    `  Allowed hosts: ${config.allowedHosts ? `${config.allowedHosts.length} (demo mode)` : 'any'}`
  );
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  /* eslint-enable no-console */
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server };
