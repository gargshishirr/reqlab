/*
 * Thin client for the ReqLab backend.
 *
 * The backend is a STATELESS proxy: it forwards a request and returns the
 * response. It stores nothing. All of your data (collections, environments,
 * history, tabs) is kept in this browser's localStorage by app.js — it is
 * never sent to the server to be persisted.
 */
(function (global) {
  'use strict';

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
  };
})(window);
