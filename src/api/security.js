'use strict';

const net = require('net');

/**
 * Browser-facing protections: security headers (including a Content Security Policy) on every response,
 * a same-origin check for anything that changes state (CSRF), and a Host check that stops DNS-rebinding
 * attacks on a local copy that has no password.
 */

// Only ReqLab's own files may run or load. Inline styles stay allowed because the HTML preview (a
// sandboxed srcdoc iframe, which inherits this policy) shows a response's own inline styles; nothing
// can be fetched from other sites, so a previewed page can't load trackers or leak anything.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const firstValue = (header) => (header ? String(header).split(',')[0].trim() : '');

/** True when the visitor reached us over HTTPS, directly or through the host's proxy (X-Forwarded-Proto). */
function isHttps(req) {
  return Boolean(req.socket && req.socket.encrypted) || firstValue(req.get('x-forwarded-proto')).toLowerCase() === 'https';
}

/** The host name in a Host header value such as "example.com:4000" or "[::1]:4000". */
function hostnameOf(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  const name = value.startsWith('[') ? value.slice(1, value.indexOf(']')) : value.replace(/:\d*$/, '');
  return name.replace(/\.$/, '');
}

/**
 * True for IP addresses and names that only this machine or the local network can resolve (localhost,
 * single-label names, .local, .lan, .internal, .home.arpa). A website can't point these at an address
 * of its choosing, so DNS rebinding can't use them.
 */
function isLocalName(hostname) {
  if (!hostname || net.isIP(hostname) || !hostname.includes('.')) return true;
  return /\.(localhost|local|lan|internal|home\.arpa)$/.test(hostname);
}

const isLocalHost = (req) => isLocalName(hostnameOf(req.get('host')));

/** True when the page was opened on this machine itself (localhost, 127.x.x.x or ::1). */
function isLoopbackHost(req) {
  const name = hostnameOf(req.get('host'));
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127\.\d+\.\d+\.\d+$/.test(name);
}

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    // "same-origin" rather than "no-referrer": with no-referrer, browsers send "Origin: null" on our
    // own form posts, which the same-origin check below would have to refuse.
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  // Never for localhost: HSTS there would force HTTPS on every other local project too.
  if (isHttps(req) && !isLocalHost(req)) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const withoutDefaultPort = (host) => String(host || '').toLowerCase().replace(/:(80|443)$/, '');

/**
 * True unless a browser tells us the request came from another site (or another origin on the same
 * site). Modern browsers send Sec-Fetch-Site; older ones send Origin on POST. Requests with neither come
 * from tools such as curl, which can't ride on a visitor's cookies.
 */
function isSameOriginRequest(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = req.get('origin');
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host; // "null" (sandboxed frames, privacy modes) does not parse
  } catch (_err) {
    return false;
  }
  return [req.get('host'), firstValue(req.get('x-forwarded-host'))].some(
    (expected) => expected && withoutDefaultPort(expected) === withoutDefaultPort(host)
  );
}

/** CSRF protection: state-changing requests (the proxy, sign-in, sign-out) must come from ReqLab itself. */
function sameOriginOnly(req, res, next) {
  if (SAFE_METHODS.has(req.method) || isSameOriginRequest(req)) return next();
  return res.status(403).json({ error: 'This request came from another website, so it was blocked.' });
}

const REBINDING_MESSAGE =
  'ReqLab blocked this request. This copy has no password and can reach your private network, so it only ' +
  'answers on localhost or an IP address. That stops websites from using it through DNS rebinding. To open ' +
  'it through a domain name, set REQLAB_PASSWORD (recommended) or BLOCK_PRIVATE_HOSTS=true.\n';

/**
 * DNS-rebinding protection for a local copy. Without a password and with private hosts allowed, a
 * website could point its own domain name at 127.0.0.1 and then drive this proxy around your network.
 * Such requests carry the attacker's domain in the Host header, so only local names and IP addresses
 * are answered. With a password (the attacker has no session) or BLOCK_PRIVATE_HOSTS on, it's not needed.
 */
function rebindingGuard(config) {
  if (config.password || config.blockPrivateHosts) return (_req, _res, next) => next();
  return (req, res, next) => {
    if (req.path === '/api/health' || isLocalHost(req)) return next();
    return res.status(403).type('text').send(REBINDING_MESSAGE);
  };
}

module.exports = {
  CSP,
  hostnameOf,
  isHttps,
  isLocalHost,
  isLocalName,
  isLoopbackHost,
  isSameOriginRequest,
  rebindingGuard,
  sameOriginOnly,
  securityHeaders,
};
