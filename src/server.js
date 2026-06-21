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
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ limit: '50mb', type: 'text/plain' }));

// API
app.use('/api', createRouter({ proxyHandler }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'endpoint not found' }));

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
