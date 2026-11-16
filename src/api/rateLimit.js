'use strict';

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

module.exports = { createRateLimiter };
