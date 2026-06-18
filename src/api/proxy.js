'use strict';

const net = require('net');

/**
 * The proxy is what makes ReqLab actually work against any API: browsers block
 * cross-origin requests, so the UI hands the request to this server, which
 * forwards it with Node's `fetch` and returns the full response (status,
 * headers, body, timing, and byte size) back to the browser.
 */

// Hop-by-hop / managed headers we must not forward verbatim.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'accept-encoding', // let undici negotiate + decode automatically
]);

function sanitizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [key, value] of Object.entries(headers)) {
    if (!key) continue;
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

/** Best-effort detection of loopback / private network targets (SSRF guard). */
function isPrivateHost(hostname) {
  const host = (hostname || '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (net.isIP(host) === 0) {
    // Not a raw IP (it's a domain name) — can't classify cheaply; allow.
    return false;
  }
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0) return true; // loopback / private / this-host
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    return false;
  }
  // IPv6 loopback / unique-local / link-local
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) {
    return true;
  }
  return false;
}

function humanContentType(headers) {
  const ct = headers.get ? headers.get('content-type') : '';
  return (ct || '').split(';')[0].trim().toLowerCase();
}

/**
 * Build the Express handler bound to the given config.
 * @param {object} config
 */
function createProxyHandler(config) {
  return async function proxyHandler(req, res) {
    const {
      method = 'GET',
      url,
      headers = {},
      body,
      timeout,
    } = req.body || {};

    // ── Validate ────────────────────────────────────────────────────────
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'A request URL is required.' });
    }
    let target;
    try {
      target = new URL(url);
    } catch (_err) {
      return res.status(400).json({ error: 'The URL is not valid. Include http:// or https://' });
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only http and https protocols are supported.' });
    }
    if (config.blockPrivateHosts && isPrivateHost(target.hostname)) {
      return res
        .status(403)
        .json({ error: 'Requests to localhost / private addresses are blocked by this server.' });
    }

    // ── Forward ─────────────────────────────────────────────────────────
    const controller = new AbortController();
    const ms = Math.min(Number(timeout) || config.proxyTimeoutMs, config.proxyMaxTimeout);
    const timer = setTimeout(() => controller.abort(), ms);
    const started = Date.now();

    try {
      const upperMethod = String(method).toUpperCase();
      const init = {
        method: upperMethod,
        headers: sanitizeHeaders(headers),
        redirect: 'follow',
        signal: controller.signal,
      };
      if (body != null && body !== '' && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }

      const response = await fetch(url, init);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const time = Date.now() - started;

      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const contentType = humanContentType(response.headers);
      const fullSize = buffer.length;

      const payload = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        contentType,
        time,
        size: fullSize,
        url: response.url || url,
        redirected: response.redirected,
      };

      const limited = buffer.subarray(0, config.maxResponseBytes);
      if (fullSize > config.maxResponseBytes) payload.truncated = true;

      if (/^image\//.test(contentType)) {
        // Return images as base64 so the UI can preview them inline.
        payload.bodyBase64 = limited.toString('base64');
        payload.isBinary = true;
      } else {
        payload.body = limited.toString('utf8');
      }

      res.json(payload);
    } catch (err) {
      const time = Date.now() - started;
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: `Request timed out after ${ms} ms.`, time });
      }
      // DNS failures, refused connections, TLS errors, etc.
      return res.status(502).json({
        error: err.cause && err.cause.code ? `${err.message} (${err.cause.code})` : err.message,
        time,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createProxyHandler, isPrivateHost, sanitizeHeaders };
