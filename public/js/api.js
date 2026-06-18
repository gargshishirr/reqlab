/*
 * Thin client for the ReqLab backend (proxy + persisted store).
 */
(function (global) {
  'use strict';

  async function json(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    let data = null;
    try {
      data = await res.json();
    } catch (_e) {
      /* ignore */
    }
    if (!res.ok) throw new Error((data && data.error) || res.statusText || 'request failed');
    return data;
  }

  global.RL_api = {
    /**
     * Forward a request through the server-side proxy.
     * Resolves with the proxy payload, which may contain `error` (handled,
     * non-2xx upstream / network problems) instead of throwing.
     */
    async proxy(payload) {
      const res = await fetch('/api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      return data; // may be { ...response } or { error, time }
    },

    getStore() {
      return json('GET', '/api/store');
    },

    saveStore(partial) {
      return json('PUT', '/api/store', partial);
    },
  };
})(window);
