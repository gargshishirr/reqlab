'use strict';

// The whole app (createApp): password protection, CSRF and DNS-rebinding protection, security headers.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { createApp } = require('../src/app');
const { createLoginLimiter } = require('../src/api/auth');
const { visitorKey } = require('../src/api/rateLimit');

const PASSWORD = 'correct horse battery';
const baseConfig = {
  proxyTimeoutMs: 5000,
  proxyMaxTimeout: 10000,
  maxResponseBytes: 1048576,
  maxBodyBytes: 1048576,
  blockPrivateHosts: false,
  password: PASSWORD,
  sessionHours: 12,
};

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

/** Starts ReqLab; failed sign-ins answer at once (no 1 s pause) unless a test asks otherwise. */
const start = (t, config, deps = {}) =>
  listen(t, http.createServer(createApp(config, { ...deps, auth: { failureDelayMs: 0, ...deps.auth } })));

/** A target API that records the headers of each request it gets. */
async function echoTarget(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, headers: req.headers });
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  return { base: await listen(t, server), seen };
}

const signIn = (base, { password = PASSWORD, username, headers = {} } = {}) =>
  fetch(`${base}/login`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(username === undefined ? { password } : { username, password }),
    redirect: 'manual',
  });
const cookieOf = (res) => res.headers.getSetCookie()[0].split(';')[0];
const proxy = (base, request, headers = {}) =>
  fetch(`${base}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(request),
  });

/** A raw request, for headers fetch won't let us set (Host). */
function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('password: pages and the API need a session; the health check and sign-in page stay open', async (t) => {
  const base = await start(t, baseConfig);

  for (const path of ['/', '/index.html', '/js/app.js']) {
    const res = await fetch(`${base}${path}`, { redirect: 'manual' });
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), '/login', path);
  }
  const api = await proxy(base, { method: 'GET', url: 'https://example.com/' });
  assert.equal(api.status, 401);
  assert.equal((await api.json()).signIn, '/login');
  assert.equal((await fetch(`${base}/api/session`)).status, 401);

  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/css/styles.css`)).status, 200);
  const page = await fetch(`${base}/login`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.match(html, /name="password" type="password" autocomplete="current-password"/);
  assert.doesNotMatch(html, /id="username"/); // no user name is asked for unless one is set
});

test('password: the sign-in page warns when the password would travel without HTTPS', async (t) => {
  const base = await start(t, baseConfig);
  const warning = /not using HTTPS/;
  assert.doesNotMatch((await raw(base, '/login', { headers: { Host: '127.0.0.1:4000' } })).text, warning);
  assert.match((await raw(base, '/login', { headers: { Host: '192.168.1.20:4000' } })).text, warning);
  const viaHttps = await raw(base, '/login', { headers: { Host: 'reqlab.example.com', 'X-Forwarded-Proto': 'https' } });
  assert.doesNotMatch(viaHttps.text, warning);
});

test('password: signing in sets a signed, HttpOnly, SameSite=Strict cookie (Secure behind HTTPS)', async (t) => {
  const base = await start(t, baseConfig);

  const wrong = await signIn(base, { password: 'not the password' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.headers.getSetCookie(), []);
  assert.match(await wrong.text(), /Wrong password\./);

  const res = await signIn(base);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/');
  const [cookie] = res.headers.getSetCookie();
  assert.match(cookie, /^reqlab_session=v1\.[\w-]+\.[\w-]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Strict$/);

  const session = cookieOf(res);
  assert.equal((await fetch(`${base}/`, { headers: { Cookie: session } })).status, 200);
  const info = await (await fetch(`${base}/api/session`, { headers: { Cookie: session } })).json();
  assert.equal(info.auth, true);
  assert.equal(info.user, null);
  assert.ok(info.expiresAt > Date.now());

  // Behind an HTTPS proxy (as on Render) the cookie is Secure and uses the __Host- prefix.
  const secure = await signIn(base, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(secure.headers.getSetCookie()[0], /^__Host-reqlab_session=.*; HttpOnly; SameSite=Strict; Secure$/);
  const secureSession = cookieOf(secure);
  const ok = await fetch(`${base}/api/session`, { headers: { Cookie: secureSession, 'X-Forwarded-Proto': 'https' } });
  assert.equal(ok.status, 200);
});

test('password: the session cookie and the visitor headers are never sent on to the target API', async (t) => {
  const target = await echoTarget(t);
  const base = await start(t, baseConfig);
  const session = cookieOf(await signIn(base));

  const res = await proxy(
    base,
    { method: 'GET', url: `${target.base}/`, headers: { 'X-Test': '1' } },
    { Cookie: session, 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '203.0.113.7' }
  );
  assert.equal(res.status, 200);
  const { headers } = target.seen.pop();
  assert.equal(headers['x-test'], '1');
  assert.equal(headers.cookie, undefined);
  assert.equal(headers['cf-connecting-ip'], undefined);
  assert.equal(headers['x-forwarded-for'], undefined);
  assert.ok(!JSON.stringify(headers).includes(session.split('=')[1]));
});

test('password: tampered, expired and signed-out sessions are refused', async (t) => {
  let clock = Date.now();
  const base = await start(t, baseConfig, { auth: { now: () => clock } });
  const check = (cookie) => fetch(`${base}/api/session`, { headers: { Cookie: cookie } }).then((r) => r.status);

  const session = cookieOf(await signIn(base));
  assert.equal(await check(session), 200);

  const [name, token] = session.split('=');
  const [v, payload, sig] = token.split('.');
  const flipped = sig.slice(0, -2) + (sig.slice(-2) === 'AA' ? 'BB' : 'AA');
  assert.equal(await check(`${name}=${v}.${payload}.${flipped}`), 401);
  const longer = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), exp: clock + 1e10 })
  ).toString('base64url');
  assert.equal(await check(`${name}=${v}.${longer}.${sig}`), 401);

  clock += 12 * 3600 * 1000 + 1; // the default 12 hours have passed
  assert.equal(await check(session), 401);
  clock = Date.now();

  const out = await fetch(`${base}/logout`, { method: 'POST', headers: { Cookie: session }, redirect: 'manual' });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), '/login?signed-out=1');
  assert.match(out.headers.getSetCookie()[0], /^reqlab_session=; Path=\/; Max-Age=0;/);
  assert.equal(await check(session), 401); // a kept copy of the cookie no longer works
  assert.match(await (await fetch(`${base}/login?signed-out=1`)).text(), /You are signed out\./);
});

test('password: SESSION_SECRET keeps sign-ins across restarts; a new password ends them', async (t) => {
  const config = { ...baseConfig, sessionSecret: 'a long random test secret' };
  const first = await start(t, config);
  const session = cookieOf(await signIn(first));

  const restarted = await start(t, config);
  assert.equal((await fetch(`${restarted}/api/session`, { headers: { Cookie: session } })).status, 200);

  const newPassword = await start(t, { ...config, password: 'another long password' });
  assert.equal((await fetch(`${newPassword}/api/session`, { headers: { Cookie: session } })).status, 401);
});

test('password: a user name, when set, is required too', async (t) => {
  const base = await start(t, { ...baseConfig, username: 'owner' });
  assert.match(await (await fetch(`${base}/login`)).text(), /id="username"/);

  const wrongUser = await signIn(base, { username: 'admin' });
  assert.equal(wrongUser.status, 401);
  assert.match(await wrongUser.text(), /Wrong user name or password\./);
  assert.equal((await signIn(base)).status, 401); // no user name at all

  const ok = await signIn(base, { username: 'owner' });
  assert.equal(ok.status, 303);
  const info = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookieOf(ok) } })).json();
  assert.equal(info.user, 'owner');
});

test('password: repeated wrong passwords lock that visitor out for 15 minutes', async (t) => {
  let clock = Date.now();
  const base = await start(t, { ...baseConfig, clientIpHeader: 'cf-connecting-ip' }, { auth: { now: () => clock } });
  const from = (ip, password) => signIn(base, { password, headers: { 'CF-Connecting-IP': ip } });

  for (let i = 1; i <= 4; i++) assert.equal((await from('203.0.113.7', `wrong ${i}`)).status, 401);
  const locked = await from('203.0.113.7', 'wrong 5');
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('retry-after'), '900');
  assert.match(await locked.text(), /Too many wrong attempts\. Try again in 15 minutes\./);

  const stillLocked = await from('203.0.113.7', PASSWORD); // not even the right password is checked
  assert.equal(stillLocked.status, 429);
  assert.deepEqual(stillLocked.headers.getSetCookie(), []);
  assert.equal((await from('198.51.100.9', PASSWORD)).status, 303); // someone else is not affected

  clock += 15 * 60 * 1000;
  assert.equal((await from('203.0.113.7', PASSWORD)).status, 303);
});

test('password: failed sign-ins are slowed down', async (t) => {
  const base = await start(t, baseConfig, { auth: { failureDelayMs: 300 } });
  const started = Date.now();
  assert.equal((await signIn(base, { password: 'wrong password' })).status, 401);
  assert.ok(Date.now() - started >= 290);
});

test('sign-in lockout: too many failures from all visitors together pause sign-ins for everyone', () => {
  let clock = 0;
  const limiter = createLoginLimiter({ maxFailures: 5, maxTotalFailures: 3, lockMs: 1000, now: () => clock });
  assert.equal(limiter.fail('a'), 0);
  assert.equal(limiter.fail('b'), 0);
  assert.equal(limiter.retryAfter('c'), 0);
  assert.equal(limiter.fail('c'), 1);
  assert.equal(limiter.retryAfter('d'), 1); // a new visitor waits too
  clock = 1000;
  assert.equal(limiter.retryAfter('d'), 0);
});

test('password: a password shorter than 8 characters stops the server from starting', () => {
  assert.throws(() => createApp({ ...baseConfig, password: 'Pa55!x' }), (err) => {
    assert.match(err.message, /REQLAB_PASSWORD is too short: use at least 8 characters/);
    assert.ok(!err.message.includes('Pa55!x')); // the password itself is never printed
    return true;
  });
});

test('password: request bodies are only read after signing in', async (t) => {
  const base = await start(t, baseConfig);
  const big = JSON.stringify({ method: 'POST', url: 'https://example.com/', body: 'x'.repeat(1100000) });
  const anonymous = await fetch(`${base}/api/proxy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big });
  assert.equal(anonymous.status, 401);

  const session = cookieOf(await signIn(base));
  const signedIn = await fetch(`${base}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session },
    body: big,
  });
  assert.equal(signedIn.status, 413);
  assert.match((await signedIn.json()).error, /too large for this server \(the limit is 1 MB\)/);
});

test('CSRF: requests from other websites are refused, ReqLab’s own pass', async (t) => {
  const target = await echoTarget(t);
  const base = await start(t, baseConfig);
  const session = cookieOf(await signIn(base));
  const send = (headers) => proxy(base, { method: 'GET', url: `${target.base}/` }, { Cookie: session, ...headers });

  assert.equal((await send({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send({ 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await send({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ Origin: 'null' })).status, 403);
  assert.equal((await send({ 'Sec-Fetch-Site': 'same-origin', Origin: base })).status, 200);
  assert.equal((await send({ Origin: base })).status, 200); // older browsers: Origin only
  assert.equal((await send({})).status, 200); // tools such as curl send neither

  const crossSiteLogin = await signIn(base, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSiteLogin.status, 403);
  const crossSiteLogout = await fetch(`${base}/logout`, {
    method: 'POST',
    headers: { Cookie: session, Origin: 'https://evil.example' },
    redirect: 'manual',
  });
  assert.equal(crossSiteLogout.status, 403);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: session } })).status, 200);
});

test('no password: /login goes home and /api/session reports it', async (t) => {
  const base = await start(t, { ...baseConfig, password: '' });
  const login = await fetch(`${base}/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/');
  assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), { auth: false });
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('security headers: a strict CSP and friends on every page; API answers are not cached', async (t) => {
  const base = await start(t, { ...baseConfig, password: '', blockPrivateHosts: true });

  const page = await fetch(`${base}/`);
  const csp = page.headers.get('content-security-policy');
  for (const part of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) {
    assert.ok(csp.includes(part), part);
  }
  assert.ok(!/script-src[^;]*unsafe/.test(csp));
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.equal(page.headers.get('strict-transport-security'), null); // plain HTTP
  assert.equal((await fetch(`${base}/api/health`)).headers.get('cache-control'), 'no-store');

  const viaHttps = await raw(base, '/', { headers: { Host: 'reqlab.example.com', 'X-Forwarded-Proto': 'https' } });
  assert.equal(viaHttps.headers['strict-transport-security'], 'max-age=15552000');
  const localHttps = await raw(base, '/', { headers: { Host: 'localhost:4000', 'X-Forwarded-Proto': 'https' } });
  assert.equal(localHttps.headers['strict-transport-security'], undefined);
});

test('DNS rebinding: a local copy without a password only answers on local names and IP addresses', async (t) => {
  const local = await start(t, { ...baseConfig, password: '' });
  for (const host of ['localhost:4000', '127.0.0.1:4000', '192.168.1.20:4000', '[::1]:4000', 'mybox.local', 'mybox']) {
    assert.equal((await raw(local, '/api/session', { headers: { Host: host } })).status, 200, host);
  }
  const rebound = await raw(local, '/api/session', { headers: { Host: 'rebind.attacker.example:4000' } });
  assert.equal(rebound.status, 403);
  assert.match(rebound.text, /set REQLAB_PASSWORD \(recommended\) or BLOCK_PRIVATE_HOSTS=true/);
  const blockedProxy = await raw(local, '/api/proxy', {
    method: 'POST',
    headers: { Host: 'rebind.attacker.example:4000', 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'GET', url: 'http://127.0.0.1:9/' }),
  });
  assert.equal(blockedProxy.status, 403);
  assert.equal((await raw(local, '/api/health', { headers: { Host: 'rebind.attacker.example' } })).status, 200);

  // Not needed (and not applied) with the SSRF guard on, or with a password.
  const guarded = await start(t, { ...baseConfig, password: '', blockPrivateHosts: true });
  assert.equal((await raw(guarded, '/api/session', { headers: { Host: 'reqlab.example.com' } })).status, 200);
  const withPassword = await start(t, baseConfig);
  assert.equal((await raw(withPassword, '/', { headers: { Host: 'reqlab.example.com' } })).status, 302);
});

test('visitor keys: IPv4-mapped addresses are IPv4, and IPv6 addresses share their /64', () => {
  assert.equal(visitorKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(visitorKey('203.0.113.7'), '203.0.113.7');
  assert.equal(visitorKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(visitorKey('[2001:db8:1:2:ffff::1]'), '2001:db8:1:2::/64');
  assert.notEqual(visitorKey('2001:db8:1:3::1'), visitorKey('2001:db8:1:2::1'));
});
