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

  /** When this copy has a password and the sign-in has ended, go back to the sign-in page. */
  function signInAgain() {
    global.location.assign('/login');
    return { error: 'Your sign-in has ended. Opening the sign-in page…' };
  }

  async function readJson(res) {
    try {
      return await res.json();
    } catch (_e) {
      return { error: `The ReqLab server sent an unexpected answer (HTTP ${res.status}).` };
    }
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
      if (res.status === 401) return signInAgain();
      return readJson(res); // may be { ...response } or { error, time }
    },

    /** { auth: false } without a password; otherwise { auth: true, user, expiresAt }. */
    async session() {
      const res = await fetch('/api/session');
      if (res.status === 401) return signInAgain();
      return readJson(res);
    },
  };
})(window);
