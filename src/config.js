'use strict';

/**
 * Central configuration for ReqLab.
 *
 * Values come from environment variables (optionally loaded from a local
 * `.env` file) with sensible zero-config defaults.
 */

const fs = require('fs');
const path = require('path');

// ── Minimal .env loader (no extra dependency) ─────────────────────────────
function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function int(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isNaN(n) ? fallback : n;
}
function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

module.exports = {
  port: int('PORT', 4000),
  host: process.env.HOST || '0.0.0.0',

  proxyTimeoutMs: int('PROXY_TIMEOUT_MS', 30000),
  proxyMaxTimeout: int('PROXY_MAX_TIMEOUT', 120000),
  maxResponseBytes: int('MAX_RESPONSE_BYTES', 26214400),
  blockPrivateHosts: bool('BLOCK_PRIVATE_HOSTS', false),

  dataDir: process.env.DATA_DIR || './data',
};
