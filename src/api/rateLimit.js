'use strict';

const net = require('net');
const { ipv6Groups } = require('./guard');

/**
 * Who is asking, for the rate limit and the sign-in lockout: a header the host's own proxy sets (such as
 * cf-connecting-ip on Render), otherwise the connecting address. See `visitorKey` for how it is grouped.
 */
function clientKey(req, header) {
  const value = header && req.get(header);
  return visitorKey((value && value.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown');
}

/**
 * One key per visitor: an IPv4-mapped IPv6 address counts as its IPv4 address, and any other IPv6 address
 * as its /64 network, because one home or phone usually gets a whole /64 and could rotate through it.
 */
function visitorKey(address) {
  const ip = String(address).replace(/^\[|\]$/g, '');
  const g = net.isIPv6(ip) ? ipv6Groups(ip) : null;
  if (!g) return ip;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * A small in-memory rate limit for a publicly hosted ReqLab: at most `perClient` proxied requests per
 * visitor and `total` for the whole server in each window (0 turns a limit off). Counts live in memory
 * only, like everything else on this stateless server.
 */
function createRateLimiter({ perClient = 0, total = 0, windowMs = 60000, now = Date.now } = {}) {
  if (!perClient && !total) return null;
  let windowStart = now();
  let totalCount = 0;
  let counts = new Map();
  return {
    /** Returns 0 when the request may go ahead, otherwise the seconds to wait. */
    take(clientKey) {
      const t = now();
      if (t - windowStart >= windowMs) {
        windowStart = t;
        totalCount = 0;
        counts = new Map();
      }
      const wait = Math.max(1, Math.ceil((windowStart + windowMs - t) / 1000));
      if (total && totalCount >= total) return wait;
      const used = counts.get(clientKey) || 0;
      if (perClient && used >= perClient) return wait;
      counts.set(clientKey, used + 1);
      totalCount += 1;
      return 0;
    },
  };
}

module.exports = { clientKey, createRateLimiter, visitorKey };
