'use strict';

const express = require('express');

/**
 * REST router for ReqLab's persisted data (collections, environments, history)
 * plus the request proxy.
 *
 * @param {object} deps
 * @param {import('../store').Store} deps.store
 * @param {Function} deps.proxyHandler
 */
function createRouter({ store, proxyHandler }) {
  const router = express.Router();

  const handle = (fn) => (req, res) => {
    try {
      fn(req, res);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  // Liveness probe
  router.get(
    '/health',
    handle((_req, res) => res.json({ status: 'ok', time: Date.now() }))
  );

  // The request-forwarding proxy.
  router.post('/proxy', proxyHandler);

  // ── Persisted store ──────────────────────────────────────────────────
  // Return everything the UI needs to hydrate.
  router.get(
    '/store',
    handle((_req, res) => res.json(store.getAll()))
  );

  // Merge a partial update ({ collections?, environments?, history? }).
  router.put(
    '/store',
    handle((req, res) => res.json(store.update(req.body)))
  );

  return router;
}

module.exports = { createRouter };
