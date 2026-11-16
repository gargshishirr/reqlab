'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const { createProxyHandler, isPrivateHost, sanitizeHeaders } = require('../src/api/proxy');
const { createRouter } = require('../src/api/routes');

// ── Pure helpers ────────────────────────────────────────────────────────────
test('isPrivateHost: classifies loopback / private / public', () => {
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('10.1.2.3'), true);
  assert.equal(isPrivateHost('192.168.0.5'), true);
  assert.equal(isPrivateHost('172.16.5.4'), true);
  assert.equal(isPrivateHost('::1'), true);
  assert.equal(isPrivateHost('api.example.com'), false);
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(isPrivateHost('172.32.0.1'), false); // just outside private range
});

test('sanitizeHeaders: strips hop-by-hop and keeps user headers', () => {
  const out = sanitizeHeaders({
    Host: 'evil.example',
    'Content-Length': '10',
    Connection: 'keep-alive',
    Authorization: 'Bearer x',
    'X-Custom': 'yes',
  });
  assert.equal(out.Host, undefined);
  assert.equal(out['Content-Length'], undefined);
  assert.equal(out.Connection, undefined);
  assert.equal(out.Authorization, 'Bearer x');
  assert.equal(out['X-Custom'], 'yes');
});

// ── Integration: stateless proxy against a local target ─────────────────────
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('proxy API: forwards requests (server stores nothing)', async (t) => {
  // A target server that echoes back what it received.
  const target = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-target', 'reqlab-test');
      res.end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization || null }));
    });
  });
  const targetPort = await listen(target);

  // The ReqLab app (stateless proxy) under test.
  const config = {
    proxyTimeoutMs: 5000,
    proxyMaxTimeout: 10000,
    maxResponseBytes: 1048576,
    blockPrivateHosts: false,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter({ proxyHandler: createProxyHandler(config) }));
  const appServer = http.createServer(app);
  const appPort = await listen(appServer);

  after(() => {
    target.close();
    appServer.close();
  });

  const base = `http://127.0.0.1:${appPort}`;
  const targetUrl = `http://127.0.0.1:${targetPort}/echo`;

  await t.test('forwards a POST with body and headers', async () => {
    const res = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'POST',
        url: targetUrl,
        headers: { Authorization: 'Bearer t0ken', 'Content-Type': 'application/json' },
        body: '{"hello":"world"}',
      }),
    });
    const data = await res.json();
    assert.equal(data.status, 200);
    assert.equal(data.headers['x-target'], 'reqlab-test');
    const echoed = JSON.parse(data.body);
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.body, '{"hello":"world"}');
    assert.equal(echoed.auth, 'Bearer t0ken');
    assert.ok(typeof data.time === 'number');
    assert.ok(data.size > 0);
  });

  await t.test('rejects an invalid URL', async () => {
    const res = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: 'not-a-url' }),
    });
    assert.equal(res.status, 400);
  });

  await t.test('exposes no persistence endpoint (server is stateless)', async () => {
    const res = await fetch(`${base}/api/store`);
    assert.equal(res.status, 404);
  });

  await t.test('blocks private hosts when configured', async () => {
    const strictConfig = { ...config, blockPrivateHosts: true };
    const strictApp = express();
    strictApp.use(express.json());
    strictApp.use('/api', createRouter({ proxyHandler: createProxyHandler(strictConfig) }));
    const strictServer = http.createServer(strictApp);
    const strictPort = await listen(strictServer);
    after(() => strictServer.close());

    const res = await fetch(`http://127.0.0.1:${strictPort}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'GET', url: 'http://127.0.0.1:9/x' }),
    });
    assert.equal(res.status, 403);
  });
});

// ── Public-instance protections ────────────────────────────────────────────
const { isPrivateAddress, checkHost } = require('../src/api/guard');

test('isPrivateHost: brackets, mapped IPv4, shared and reserved ranges', () => {
  for (const host of [
    '[::1]', '::1', '[::]', '[::ffff:7f00:1]', '::ffff:127.0.0.1', '[::ffff:a9fe:a9fe]',
    '0.0.0.0', '100.64.0.1', '169.254.169.254', '224.0.0.1', '255.255.255.255',
    '[fd12::1]', 'fe80::1', '64:ff9b::7f00:1', '2002:7f00:1::', 'metadata.google.internal', 'LOCALHOST.',
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['1.1.1.1', '[2606:4700:4700::1111]', '100.128.0.1', 'example.com']) {
    assert.equal(isPrivateHost(host), false, host);
  }
  assert.equal(isPrivateAddress('not-an-ip'), true);
});

test('checkHost: a domain name is blocked when any of its addresses is private', async () => {
  const lookup = async (host) =>
    ({
      'public.test': [{ address: '93.184.216.34', family: 4 }],
      'sneaky.test': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
      'mapped.test': [{ address: '::ffff:127.0.0.1', family: 6 }],
    })[host];
  await checkHost('public.test', lookup);
  await assert.rejects(checkHost('sneaky.test', lookup), { name: 'BlockedHostError' });
  await assert.rejects(checkHost('mapped.test', lookup), { name: 'BlockedHostError' });
  await assert.rejects(checkHost('[::1]', lookup), { name: 'BlockedHostError' });
});

function proxyApp(config, deps) {
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter({ proxyHandler: createProxyHandler(config, deps) }));
  return http.createServer(app);
}
const baseConfig = { proxyTimeoutMs: 5000, proxyMaxTimeout: 10000, maxResponseBytes: 1048576, blockPrivateHosts: false };
const send = (port, request) =>
  fetch(`http://127.0.0.1:${port}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

test('proxy API: every redirect hop passes the SSRF guard', async () => {
  const calls = [];
  const deps = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetch: async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/secret' } });
    },
  };
  const server = proxyApp({ ...baseConfig, blockPrivateHosts: true }, deps);
  const port = await listen(server);
  after(() => server.close());

  const res = await send(port, { method: 'GET', url: 'http://public.test/start' });
  assert.equal(res.status, 403);
  assert.deepEqual(calls, ['http://public.test/start']); // the private address was never contacted

  const blocked = await send(port, { method: 'GET', url: 'http://[::ffff:127.0.0.1]:9/x' });
  assert.equal(blocked.status, 403);
});

test('proxy API: follows redirects like fetch and caps the response size', async () => {
  const seen = [];
  const final = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, auth: req.headers.authorization || null, body });
      res.setHeader('content-type', 'text/plain');
      res.end(req.url === '/big' ? 'x'.repeat(100) : 'done');
    });
  });
  const finalPort = await listen(final);
  const hop = http.createServer((req, res) => {
    res.statusCode = req.url === '/see-other' ? 303 : 302;
    res.setHeader('location', `http://127.0.0.1:${finalPort}${req.url === '/to-big' ? '/big' : '/final'}`);
    req.resume();
    req.on('end', () => res.end());
  });
  const hopPort = await listen(hop);
  const server = proxyApp({ ...baseConfig, maxResponseBytes: 10 });
  const port = await listen(server);
  after(() => {
    final.close();
    hop.close();
    server.close();
  });

  // A 303 after a POST becomes a GET without a body, and credentials stay with the first site.
  const res = await send(port, {
    method: 'POST',
    url: `http://127.0.0.1:${hopPort}/see-other`,
    headers: { Authorization: 'Bearer t0ken', 'Content-Type': 'text/plain' },
    body: 'payload',
  });
  const data = await res.json();
  assert.equal(data.status, 200);
  assert.equal(data.redirected, true);
  assert.equal(data.url, `http://127.0.0.1:${finalPort}/final`);
  assert.equal(data.body, 'done');
  assert.deepEqual(seen.pop(), { method: 'GET', auth: null, body: '' });

  const big = await (await send(port, { method: 'GET', url: `http://127.0.0.1:${hopPort}/to-big` })).json();
  assert.equal(big.truncated, true);
  assert.equal(big.body, 'x'.repeat(10));
  assert.ok(big.size > 10);
});

test('proxy API: rate limit per visitor', async () => {
  const target = http.createServer((_req, res) => res.end('ok'));
  const targetPort = await listen(target);
  const server = proxyApp({ ...baseConfig, rateLimitPerMinute: 2, clientIpHeader: 'cf-connecting-ip' });
  const port = await listen(server);
  after(() => {
    target.close();
    server.close();
  });
  const from = (ip) =>
    fetch(`http://127.0.0.1:${port}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ method: 'GET', url: `http://127.0.0.1:${targetPort}/` }),
    });
  assert.equal((await from('203.0.113.7')).status, 200);
  assert.equal((await from('203.0.113.7')).status, 200);
  const limited = await from('203.0.113.7');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await from('198.51.100.9')).status, 200); // someone else is not affected
});

test('allow-list: exact names, *.domain wildcards, and every redirect hop', async () => {
  const { parseAllowedHosts, checkAllowedHost } = require('../src/api/guard');
  assert.equal(parseAllowedHosts(''), null);
  const allowed = parseAllowedHosts(' api.test, *.Images.test\nother.test. ');
  assert.deepEqual(allowed, ['api.test', '*.images.test', 'other.test']);
  for (const host of ['api.test', 'API.TEST.', 'cdn.images.test', 'a.b.images.test', 'other.test']) {
    assert.doesNotThrow(() => checkAllowedHost(host, allowed), host);
  }
  for (const host of ['images.test', 'evilimages.test', 'api.test.evil.test', 'sub.api.test', '127.0.0.1']) {
    assert.throws(() => checkAllowedHost(host, allowed), { name: 'BlockedHostError' }, host);
  }
  assert.doesNotThrow(() => checkAllowedHost('anything.test', null));

  const calls = [];
  const deps = {
    fetch: async (url) => {
      calls.push(url);
      return url.startsWith('http://api.test/')
        ? new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } })
        : new Response('{}', { status: 200 });
    },
  };
  const server = proxyApp({ ...baseConfig, allowedHosts: allowed }, deps);
  const port = await listen(server);
  after(() => server.close());

  const res = await send(port, { method: 'GET', url: 'http://api.test/go' });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /only calls these test APIs: api\.test/);
  assert.deepEqual(calls, ['http://api.test/go']);

  assert.equal((await send(port, { method: 'GET', url: 'https://cdn.images.test/x.png' })).status, 200);
  assert.equal((await send(port, { method: 'GET', url: 'https://not-listed.test/' })).status, 403);
});
