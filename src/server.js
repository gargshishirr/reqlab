'use strict';

const http = require('http');

const config = require('./config');
const { createApp } = require('./app');

let app;
try {
  app = createApp(config);
} catch (err) {
  // A setting that can't work, such as a password that is too short. The message never contains it.
  console.error(`\n  ReqLab could not start: ${err.message}\n`); // eslint-disable-line no-console
  process.exit(1);
}

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
    `  Password     : ${config.password ? `ON (sign-in required${config.username ? ', with a user name' : ''})` : 'off'}`
  );
  if (config.password) {
    console.log(
      `  Sign-ins     : last ${config.sessionHours > 0 ? config.sessionHours : 12} h, ${
        config.sessionSecret ? 'kept across restarts' : 'end when the server restarts (set SESSION_SECRET to keep them)'
      }`
    );
  }
  console.log(
    `  SSRF guard   : ${config.blockPrivateHosts ? 'ON (private hosts blocked)' : 'off'}`
  );
  const limits = [
    config.rateLimitPerMinute && `${config.rateLimitPerMinute}/min per visitor`,
    config.rateLimitTotalPerMinute && `${config.rateLimitTotalPerMinute}/min in total`,
  ].filter(Boolean);
  console.log(`  Rate limit   : ${limits.length ? limits.join(', ') : 'off'}`);
  console.log(
    `  Allowed hosts: ${
      config.allowedHosts && !config.password
        ? `${config.allowedHosts.length} (demo mode)`
        : `any${config.allowedHosts ? ' (ALLOWED_HOSTS is not used when a password is set)' : ''}`
    }`
  );
  if (!config.password && !config.blockPrivateHosts) {
    console.log('  Local mode   : answers on localhost and IP addresses only (set a password to use a domain name)');
  }
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
