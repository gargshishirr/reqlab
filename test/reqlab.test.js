'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { createProxyHandler, isPrivateHost, sanitizeHeaders } = require('../src/api/proxy');
const { createRouter } = require('../src/api/routes');
const { Store } = require('../src/store');

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

// ── Store ───────────────────────────────────────────────────────────────────
test('store: persists and merges partial updates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlab-'));
  const store = new Store(dir);

  assert.deepEqual(store.getAll().collections, []);
  store.update({ collections: [{ id: 'a', name: 'A', requests: [] }] });
  store.update({ environments: [{ id: 'e', name: 'Env', variables: [] }] });

  // Reload from disk to confirm persistence.
  const reloaded = new Store(dir);
  assert.equal(reloaded.getAll().collections.length, 1);
  assert.equal(reloaded.getAll().collections[0].name, 'A');
  assert.equal(reloaded.getAll().environments.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('store: caps history length', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlab-'));
  const store = new Store(dir);
  const big = Array.from({ length: 500 }, (_, i) => ({ id: i }));
  store.update({ history: big });
  assert.ok(store.getAll().history.length <= 200);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Integration: proxy + store router against a local target ────────────────
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('proxy + store API: forwards requests and round-trips data', async (t) => {
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

  // The ReqLab app (proxy + store) under test.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqlab-'));
  const store = new Store(dir);
  const config = { proxyTimeoutMs: 5000, proxyMaxTimeout: 10000, maxResponseBytes: 1048576, blockPrivateHosts: false };
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter({ store, proxyHandler: createProxyHandler(config) }));
  const appServer = http.createServer(app);
  const appPort = await listen(appServer);

  after(() => {
    target.close();
    appServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
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

  await t.test('store round-trips via the API', async () => {
    const put = await fetch(`${base}/api/store`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collections: [{ id: 'c1', name: 'Mine', requests: [] }] }),
    });
    assert.equal(put.status, 200);
    const get = await (await fetch(`${base}/api/store`)).json();
    assert.equal(get.collections.length, 1);
    assert.equal(get.collections[0].name, 'Mine');
  });

  await t.test('blocks private hosts when configured', async () => {
    const strictConfig = { ...config, blockPrivateHosts: true };
    const strictApp = express();
    strictApp.use(express.json());
    strictApp.use('/api', createRouter({ store, proxyHandler: createProxyHandler(strictConfig) }));
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
