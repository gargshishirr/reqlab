'use strict';

const crypto = require('crypto');
const express = require('express');

const { clientKey } = require('./rateLimit');
const { isHttps, isLoopbackHost } = require('./security');

/**
 * Optional password protection for a personal hosted copy. When REQLAB_PASSWORD is set, every page and
 * API call except the health check and the sign-in page needs a session: a signed cookie (HttpOnly,
 * SameSite=Strict, and Secure with the __Host- prefix behind HTTPS) set by the sign-in page.
 *
 * The server still writes nothing to disk. The cookie carries its own expiry and an HMAC signature; only
 * sign-outs and failed attempts are remembered, in memory. The signing key mixes in the user name and
 * password, so changing the password signs everyone out.
 */

const MIN_PASSWORD_LENGTH = 8;
const COOKIE = 'reqlab_session';
const SECURE_COOKIE = '__Host-reqlab_session';
const PUBLIC_PATHS = new Set(['/api/health', '/css/styles.css']);
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A7%AA%3C/text%3E%3C/svg%3E";

const b64url = (data) => Buffer.from(data).toString('base64url');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wrong-password lockout: after `maxFailures` wrong attempts a visitor waits `lockMs` before trying again
 * (failures count for `lockMs` after the first one). If `maxTotalFailures` arrive from all visitors
 * together in one such window, everyone without a session waits for the window to end, which slows
 * guessing from many addresses. People who are already signed in are not affected.
 */
function createLoginLimiter({
  maxFailures = 5,
  lockMs = 15 * 60 * 1000,
  maxTotalFailures = 100,
  maxEntries = 10000,
  now = Date.now,
} = {}) {
  const visitors = new Map();
  let totalSince = now();
  let totalFailures = 0;

  function current(key, t) {
    const entry = visitors.get(key);
    if (entry && entry.lockedUntil <= t && t - entry.since >= lockMs) {
      visitors.delete(key);
      return null;
    }
    return entry || null;
  }

  function retryAfter(key) {
    const t = now();
    if (t - totalSince >= lockMs) {
      totalSince = t;
      totalFailures = 0;
    }
    const entry = current(key, t);
    const until = Math.max(entry ? entry.lockedUntil : 0, totalFailures >= maxTotalFailures ? totalSince + lockMs : 0);
    return until > t ? Math.ceil((until - t) / 1000) : 0;
  }

  return {
    /** Seconds this visitor must wait before trying again (0 = may try now). */
    retryAfter,
    /** Records a wrong attempt; returns the seconds to wait if this visitor is now locked out. */
    fail(key) {
      const t = now();
      totalFailures += 1;
      let entry = current(key, t);
      if (!entry) {
        if (visitors.size >= maxEntries) {
          for (const k of visitors.keys()) {
            current(k, t);
            if (visitors.size < maxEntries) break;
          }
          if (visitors.size >= maxEntries) visitors.delete(visitors.keys().next().value);
        }
        entry = { failures: 0, since: t, lockedUntil: 0 };
        visitors.set(key, entry);
      }
      entry.failures += 1;
      if (entry.failures >= maxFailures) entry.lockedUntil = t + lockMs;
      return retryAfter(key);
    },
    succeed(key) {
      visitors.delete(key);
    },
  };
}

/** Signed, self-expiring session tokens: "v1.<payload>.<HMAC-SHA256 signature>", all base64url. */
function createSessions({ secret, username, password, maxAgeMs, now, maxRevoked = 10000 }) {
  const key = crypto.createHmac('sha256', secret).update(`reqlab-session-v1\0${username}\0${password}`).digest();
  const sign = (data) => crypto.createHmac('sha256', key).update(data).digest();
  const revoked = new Map();

  return {
    issue() {
      const payload = { sid: b64url(crypto.randomBytes(16)), exp: now() + maxAgeMs };
      const body = `v1.${b64url(JSON.stringify(payload))}`;
      return { token: `${body}.${b64url(sign(body))}`, ...payload };
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 400) return null;
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== 'v1') return null;
      const given = Buffer.from(parts[2], 'base64url');
      const expected = sign(`v1.${parts[1]}`);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
      let payload;
      try {
        payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch (_err) {
        return null;
      }
      if (!payload || typeof payload.sid !== 'string' || typeof payload.exp !== 'number') return null;
      if (payload.exp <= now() || revoked.has(payload.sid)) return null;
      return payload;
    },
    /** Ends a session before it expires (kept in memory until then, so a copy of the cookie stops working). */
    revoke(session) {
      const t = now();
      for (const [sid, exp] of revoked) if (exp <= t) revoked.delete(sid);
      if (revoked.size >= maxRevoked) revoked.delete(revoked.keys().next().value);
      revoked.set(session.sid, session.exp);
    },
  };
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function loginPage({ askUsername, error = '', notice = '', insecure = false }) {
  const userField = askUsername
    ? `<div class="field">
        <label for="username">User name</label>
        <input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus />
      </div>`
    : // Helps password managers, which like a user name to file the password under.
      '<input name="username" type="text" autocomplete="username" value="reqlab" hidden />';
  return `<!DOCTYPE html>
<html lang="en" class="login">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>Sign in — ReqLab</title>
    <link rel="icon" href="${FAVICON}" />
    <link rel="stylesheet" href="/css/styles.css" />
  </head>
  <body>
    <main class="login-card">
      <div class="brand">
        <span class="brand-mark">🧪</span>
        <span class="brand-name">ReqLab</span>
      </div>
      <h1>Sign in</h1>
      <p class="muted">This ReqLab is private. Sign in to use it.</p>
      ${insecure ? '<p class="banner warn">This page is not using HTTPS, so your password could be read on the network.</p>' : ''}
      ${notice ? `<p class="login-notice" role="status">${escapeHtml(notice)}</p>` : ''}
      ${error ? `<p class="banner" role="alert">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/login">
        ${userField}
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required${askUsername ? '' : ' autofocus'} />
        </div>
        <button class="btn primary" type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>
`;
}

function disabledAuth() {
  const router = express.Router();
  router.get('/login', (_req, res) => res.redirect(302, '/'));
  router.post('/logout', (_req, res) => res.redirect(303, '/'));
  return {
    enabled: false,
    router,
    requireSignIn: (_req, _res, next) => next(),
    sessionInfo: () => ({ auth: false }),
  };
}

/**
 * @param {object} config  password, username, sessionSecret, sessionHours, clientIpHeader
 * @param {object} [deps]  test seams: `now` (a clock) and `failureDelayMs`
 */
function createAuth(config, deps = {}) {
  const password = config.password || '';
  if (!password) return disabledAuth();
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `REQLAB_PASSWORD is too short: use at least ${MIN_PASSWORD_LENGTH} characters (12 or more is better).`
    );
  }

  const username = config.username || '';
  const now = deps.now || Date.now;
  const failureDelayMs = deps.failureDelayMs === undefined ? 1000 : deps.failureDelayMs;
  const hours = config.sessionHours > 0 ? Math.min(config.sessionHours, 24 * 365) : 12;
  const maxAgeMs = Math.round(hours * 3600 * 1000);
  const sessions = createSessions({
    secret: config.sessionSecret ? Buffer.from(config.sessionSecret) : crypto.randomBytes(32),
    username,
    password,
    maxAgeMs,
    now,
  });
  const limiter = createLoginLimiter({ now });

  // Both values are compared as HMACs of the same length, in constant time, and both are always checked.
  const compareKey = crypto.randomBytes(32);
  const digest = (value) => crypto.createHmac('sha256', compareKey).update(value).digest();
  const expectedUser = digest(username);
  const expectedPassword = digest(password);
  function credentialsMatch(givenUser, givenPassword) {
    const userOk = crypto.timingSafeEqual(digest(username ? givenUser : ''), expectedUser);
    const passwordOk = crypto.timingSafeEqual(digest(givenPassword), expectedPassword);
    return userOk && passwordOk;
  }

  const cookieName = (req) => (isHttps(req) ? SECURE_COOKIE : COOKIE);
  const currentSession = (req) => sessions.verify(readCookie(req, cookieName(req)));

  function setCookie(req, res, value, maxAgeSeconds) {
    const attributes = [`${cookieName(req)}=${value}`, 'Path=/', `Max-Age=${maxAgeSeconds}`, 'HttpOnly', 'SameSite=Strict'];
    if (isHttps(req)) attributes.push('Secure');
    res.append('Set-Cookie', attributes.join('; '));
  }

  function showLogin(req, res, status, extra = {}) {
    res.set('Cache-Control', 'no-store');
    res
      .status(status)
      .type('html')
      .send(loginPage({ askUsername: Boolean(username), insecure: !isHttps(req) && !isLoopbackHost(req), ...extra }));
  }

  function tooManyAttempts(req, res, seconds) {
    res.set('Retry-After', String(seconds));
    const minutes = Math.ceil(seconds / 60);
    showLogin(req, res, 429, {
      error: `Too many wrong attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    });
  }

  const router = express.Router();

  router.get('/login', (req, res) => {
    if (currentSession(req)) return res.redirect(302, '/');
    return showLogin(req, res, 200, { notice: req.query['signed-out'] ? 'You are signed out.' : '' });
  });

  router.post(
    '/login',
    express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 10 }),
    async (req, res) => {
      const visitor = clientKey(req, config.clientIpHeader);
      const wait = limiter.retryAfter(visitor);
      if (wait) return tooManyAttempts(req, res, wait);

      const body = req.body || {};
      const givenUser = typeof body.username === 'string' ? body.username : '';
      const givenPassword = typeof body.password === 'string' ? body.password : '';
      if (credentialsMatch(givenUser, givenPassword)) {
        limiter.succeed(visitor);
        const session = sessions.issue();
        setCookie(req, res, session.token, Math.floor(maxAgeMs / 1000));
        return res.redirect(303, '/');
      }

      const locked = limiter.fail(visitor);
      if (failureDelayMs) await sleep(failureDelayMs);
      if (locked) return tooManyAttempts(req, res, locked);
      return showLogin(req, res, 401, { error: username ? 'Wrong user name or password.' : 'Wrong password.' });
    }
  );

  router.post('/logout', (req, res) => {
    const session = currentSession(req);
    if (session) sessions.revoke(session);
    setCookie(req, res, '', 0);
    res.set('Cache-Control', 'no-store');
    return res.redirect(303, '/login?signed-out=1');
  });

  // A sign-in form that is too large or malformed: show the form again rather than an error page.
  router.use('/login', (err, req, res, next) => {
    if (!err.status || err.status >= 500) return next(err);
    return showLogin(req, res, 400, { error: 'The sign-in form could not be read. Please try again.' });
  });

  function requireSignIn(req, res, next) {
    const session = currentSession(req);
    if (session) {
      req.reqlabSession = session;
      return next();
    }
    if (PUBLIC_PATHS.has(req.path)) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Your sign-in has ended. Please sign in again.', signIn: '/login' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(302, '/login');
    return res.status(401).type('text').send('Please sign in first.\n');
  }

  return {
    enabled: true,
    router,
    requireSignIn,
    sessionInfo: (req) => ({
      auth: true,
      user: username || null,
      expiresAt: req.reqlabSession ? req.reqlabSession.exp : null,
    }),
  };
}

module.exports = { createAuth, createLoginLimiter, MIN_PASSWORD_LENGTH };
