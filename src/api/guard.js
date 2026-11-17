'use strict';

const dns = require('dns');
const net = require('net');

/**
 * SSRF guard: decides whether the proxy may connect to a host. A public ReqLab must not become a way
 * into the network it runs in, so a request is blocked when its host is, or resolves to, a loopback,
 * private, link-local, shared (carrier-grade NAT), multicast or otherwise reserved address. The check
 * runs again for every redirect hop.
 */

const BLOCKED_V4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (carrier-grade NAT, some cloud internals)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata services
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including the broadcast address
]) {
  BLOCKED_V4.addSubnet(address, prefix, 'ipv4');
}

/** The eight 16-bit groups of an IPv6 address, or null if it isn't one. */
function ipv6Groups(address) {
  if (!net.isIPv6(address)) return null;
  let text = address.split('%')[0]; // drop a zone index such as %en0
  const groups = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  for (const part of left) groups.push(parseInt(part, 16));
  for (let i = 0; tail !== undefined && i < missing; i++) groups.push(0);
  for (const part of right) groups.push(parseInt(part, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi, lo) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/** True for any address the proxy must not connect to. Non-IP input counts as private. */
function isPrivateAddress(address) {
  const ip = String(address || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) return BLOCKED_V4.check(ip, 'ipv4');
  const g = ipv6Groups(ip);
  if (!g) return true;
  const zeroUpTo = (n) => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(8)) return true; // ::
  if (zeroUpTo(7) && g[7] === 1) return true; // ::1
  if (zeroUpTo(5) && g[5] === 0xffff) return isPrivateAddress(v4From(g[6], g[7])); // ::ffff:a.b.c.d
  if (zeroUpTo(6)) return isPrivateAddress(v4From(g[6], g[7])); // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateAddress(v4From(g[6], g[7])); // NAT64 64:ff9b::a.b.c.d
  }
  if (g[0] === 0x2002) return isPrivateAddress(v4From(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/**
 * Best-effort check of a URL's host name alone, without looking it up: localhost names and private IP
 * literals (IPv6 with or without brackets). Domain names count as public here; `checkHost` resolves them.
 */
function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (net.isIP(host) === 0) return false;
  return isPrivateAddress(host);
}

class BlockedHostError extends Error {
  constructor(hostname, reason = 'it is (or resolves to) a private address') {
    super(`Requests to ${hostname} are blocked by this server: ${reason}.`);
    this.name = 'BlockedHostError';
  }
}

/**
 * Parses an ALLOWED_HOSTS value: host names separated by commas or spaces, where "*.example.com" allows
 * every subdomain of example.com. Returns null when the list is empty, meaning any host is allowed.
 */
function parseAllowedHosts(value) {
  const hosts = String(value || '')
    .split(/[\s,]+/)
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean);
  return hosts.length ? hosts : null;
}

/** Throws BlockedHostError unless the host is on the allow-list (a null list allows every host). */
function checkAllowedHost(hostname, allowedHosts) {
  if (!allowedHosts) return;
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const allowed = allowedHosts.some((entry) =>
    entry.startsWith('*.') ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry
  );
  if (!allowed) {
    throw new BlockedHostError(
      hostname,
      `this public demo only calls these test APIs: ${allowedHosts.join(', ')}. Run your own copy of ReqLab to call any API`
    );
  }
}

/**
 * Throws BlockedHostError unless the host is public. Domain names are resolved, and every address they
 * resolve to must be public.
 * @param {string} hostname  URL host name (IPv6 may keep its brackets)
 * @param {Function} [lookup]  dns.promises.lookup-compatible function (tests pass a fake)
 */
async function checkHost(hostname, lookup = dns.promises.lookup) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (isPrivateHost(host)) throw new BlockedHostError(hostname);
  if (net.isIP(host)) return;
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new BlockedHostError(hostname);
  }
}

/**
 * A `lookup` function for net.connect / tls.connect that refuses private addresses at the moment of
 * connecting. `checkHost` alone can be raced: a name can resolve to a public address for the check and
 * to a private one a moment later for the real connection (DNS rebinding). With this, the connection
 * only ever goes to addresses that passed the check.
 * @param {Function} [resolve]  dns.lookup-compatible callback function (tests pass a fake)
 */
function createGuardedLookup(resolve = dns.lookup) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const opts = typeof options === 'number' ? { family: options } : options || {};
    resolve(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [];
      if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
        return callback(new BlockedHostError(hostname));
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

module.exports = {
  ipv6Groups,
  isPrivateAddress,
  isPrivateHost,
  checkHost,
  createGuardedLookup,
  parseAllowedHosts,
  checkAllowedHost,
  BlockedHostError,
};
