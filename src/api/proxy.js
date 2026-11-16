'use strict';

const { BlockedHostError, checkAllowedHost, checkHost, isPrivateHost } = require('./guard');
const { createRateLimiter } = require('./rateLimit');

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

function humanContentType(headers) {
  const ct = headers.get ? headers.get('content-type') : '';
  return (ct || '').split(';')[0].trim().toLowerCase();
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20; // the same limit as fetch's own redirect following
const BODY_HEADERS = ['content-type', 'content-encoding', 'content-language', 'content-location'];
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

function withoutHeaders(headers, names) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) if (!names.includes(key.toLowerCase())) out[key] = value;
  return out;
}

/** Who is asking, for the rate limit: a header set by the host's proxy (e.g. cf-connecting-ip), else the socket. */
function clientKey(req, header) {
  const value = header && req.get(header);
  return (value && value.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
}

/** Reads at most `limit` bytes of a response body, so a huge response can't use up the server's memory. */
async function readBody(response, limit) {
  if (!response.body) return { buffer: Buffer.alloc(0), size: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const before = received;
    received += value.byteLength;
    if (received > limit) {
      chunks.push(Buffer.from(value.subarray(0, limit - before)));
      await reader.cancel().catch(() => {});
      return { buffer: Buffer.concat(chunks), size: received, truncated: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { buffer: Buffer.concat(chunks), size: received, truncated: false };
}

async function discard(response) {
  try {
    if (response.body) await response.body.cancel();
  } catch (_err) {
    /* nothing to clean up */
  }
}

/**
 * Build the Express handler bound to the given config.
 * @param {object} config
 * @param {object} [deps]  test seams: `fetch` and a dns.promises.lookup-compatible `lookup`
 */
function createProxyHandler(config, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const limiter = createRateLimiter({
    perClient: config.rateLimitPerMinute,
    total: config.rateLimitTotalPerMinute,
  });

  return async function proxyHandler(req, res) {
    if (limiter) {
      const wait = limiter.take(clientKey(req, config.clientIpHeader));
      if (wait) {
        res.set('Retry-After', String(wait));
        return res
          .status(429)
          .json({ error: `Too many requests through this server. Try again in ${wait} seconds.` });
      }
    }

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

    // ── Forward ─────────────────────────────────────────────────────────
    const controller = new AbortController();
    const ms = Math.min(Number(timeout) || config.proxyTimeoutMs, config.proxyMaxTimeout);
    const timer = setTimeout(() => controller.abort(), ms);
    const started = Date.now();

    try {
      let current = target;
      let upperMethod = String(method).toUpperCase();
      let sendHeaders = sanitizeHeaders(headers);
      let sendBody;
      if (body != null && body !== '' && upperMethod !== 'GET' && upperMethod !== 'HEAD') {
        sendBody = typeof body === 'string' ? body : JSON.stringify(body);
      }

      // Redirects are followed here rather than by fetch, so every hop passes the allow-list and SSRF guard.
      let response;
      let redirected = false;
      for (let hop = 0; ; hop += 1) {
        checkAllowedHost(current.hostname, config.allowedHosts);
        if (config.blockPrivateHosts) await checkHost(current.hostname, deps.lookup);
        const init = { method: upperMethod, headers: sendHeaders, redirect: 'manual', signal: controller.signal };
        if (sendBody !== undefined) init.body = sendBody;
        response = await fetchImpl(current.href, init);

        const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
        if (!location) break;
        let next;
        try {
          next = new URL(location, current);
        } catch (_err) {
          break; // an unusable Location: show the redirect response itself
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') break;
        await discard(response);
        if (hop + 1 > MAX_REDIRECTS) {
          return res.status(502).json({ error: `Stopped after ${MAX_REDIRECTS} redirects.`, time: Date.now() - started });
        }
        // The same rules as fetch: 303 (and 301/302 after a POST) turn the request into a GET without
        // a body, and credentials are not sent on to another site.
        if (
          (response.status === 303 && upperMethod !== 'HEAD') ||
          ((response.status === 301 || response.status === 302) && upperMethod === 'POST')
        ) {
          upperMethod = 'GET';
          sendBody = undefined;
          sendHeaders = withoutHeaders(sendHeaders, BODY_HEADERS);
        }
        if (next.origin !== current.origin) sendHeaders = withoutHeaders(sendHeaders, CREDENTIAL_HEADERS);
        current = next;
        redirected = true;
      }

      const { buffer, size, truncated } = await readBody(response, config.maxResponseBytes);
      const time = Date.now() - started;

      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const contentType = humanContentType(response.headers);

      const payload = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        contentType,
        time,
        size,
        url: current.href,
        redirected,
      };
      if (truncated) payload.truncated = true;

      if (/^image\//.test(contentType)) {
        // Return images as base64 so the UI can preview them inline.
        payload.bodyBase64 = buffer.toString('base64');
        payload.isBinary = true;
      } else {
        payload.body = buffer.toString('utf8');
      }

      res.json(payload);
    } catch (err) {
      const time = Date.now() - started;
      if (err instanceof BlockedHostError) {
        return res.status(403).json({ error: err.message, time });
      }
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
