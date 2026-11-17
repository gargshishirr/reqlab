'use strict';

/**
 * Central configuration for ReqLab.
 *
 * Values come from environment variables (optionally loaded from a local
 * `.env` file) with sensible zero-config defaults.
 */

const fs = require('fs');
const path = require('path');
const { parseAllowedHosts } = require('./api/guard');

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
  maxBodyBytes: int('MAX_BODY_BYTES', 52428800),
  blockPrivateHosts: bool('BLOCK_PRIVATE_HOSTS', false),

  // For a public instance: proxied requests allowed per visitor, and for the whole server, each minute
  // (0 = no limit). CLIENT_IP_HEADER names a header the host's own proxy sets to the visitor's address,
  // such as cf-connecting-ip on Render; without it the connecting address is used.
  rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 0),
  rateLimitTotalPerMinute: int('RATE_LIMIT_TOTAL_PER_MINUTE', 0),
  clientIpHeader: (process.env.CLIENT_IP_HEADER || '').trim().toLowerCase(),

  // Demo mode: when set, the proxy only calls these hosts ("*.example.com" allows subdomains), so a public
  // instance can't be used as an open proxy. Empty means any host. Not used when a password is set.
  allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS),

  // Password protection for a personal hosted copy: when set, the web page and the API ask you to sign
  // in first. "off" or "none" also mean no password (some hosts insist on a value). See src/api/auth.js.
  password: passwordSetting(process.env.REQLAB_PASSWORD),
  username: (process.env.REQLAB_USERNAME || '').trim(),
  // Signs the sign-in cookie. Without it a random key is made at startup, so sign-ins end on a restart.
  sessionSecret: (process.env.SESSION_SECRET || '').trim(),
  sessionHours: int('SESSION_HOURS', 12),
};

function passwordSetting(value) {
  const password = (value || '').trim();
  return /^(off|none)$/i.test(password) ? '' : password;
}
