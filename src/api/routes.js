'use strict';

const express = require('express');

/**
 * REST router for ReqLab. The server is intentionally STATELESS — it forwards
 * requests through the proxy and stores nothing on disk. All user data
 * (collections, environments, history) lives in the browser's localStorage.
 *
 * @param {object} deps
 * @param {Function} deps.proxyHandler
 */
function createRouter({ proxyHandler }) {
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

  // The request-forwarding proxy — the only real endpoint.
  router.post('/proxy', proxyHandler);

  return router;
}

module.exports = { createRouter };

