// -----------------------------------------------------------------------------
// mDNS answers -> the addresses to read (pure).
//
// The core browses `_musc._tcp` (players) and `_musp._tcp` (secondary zones
// of the multi-zone players) and relays the raw answers:
//   [{ name, host, addresses, port, txt }]
// A candidate is an IPv4 address of the LAN and the port of the SRV record.
// The identity is never taken from the advertisement (the secondary zones
// carry no `mac` in their TXT): every candidate is read once (/SyncStatus).
// Public and loopback addresses are ignored: an announcement on the LAN must
// not steer the integration towards Gladys itself or the Internet.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT } from '../constants.js';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 10/8, 172.16/12, 192.168/16 and link-local 169.254/16. */
export function isLanIPv4(address) {
  const match = IPV4.exec(String(address ?? ''));
  if (!match) {
    return false;
  }
  const [a, b, c, d] = match.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) {
    return false;
  }
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** "Living Room._musc._tcp.local" -> "Living Room". */
export function instanceName(name) {
  const text = String(name ?? '');
  const cut = text.search(/\._mus[a-z]\._tcp/i);
  return (cut === -1 ? text : text.slice(0, cut)).trim().slice(0, 100);
}

const validPort = (port) =>
  Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;

/** The mDNS answers -> [{ host, port, name }], one per address and port. */
export function mdnsCandidates(results) {
  const candidates = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const host = (result?.addresses ?? []).find(isLanIPv4);
    if (!host) {
      continue;
    }
    const port = validPort(Number(result.port));
    const key = `${host}:${port}`;
    if (!candidates.has(key)) {
      candidates.set(key, { host, port, name: instanceName(result.name) });
    }
  }
  return [...candidates.values()];
}

/** "192.168.1.20:11000" (the `id` of /SyncStatus) -> { host, port }, or undefined. */
export function parseEndpoint(text) {
  const match = /^(.+):(\d{1,5})$/.exec(String(text ?? '').trim());
  if (!match) {
    return undefined;
  }
  const port = Number(match[2]);
  return port > 0 && port < 65536 ? { host: match[1], port } : undefined;
}

/**
 * The stable id of a player: its MAC (the first six fields: a secondary zone
 * appends its port as a seventh) and its port, letters and digits only.
 * Without a MAC, the address.
 */
export function playerIdOf({ mac, host, port }) {
  const fields = String(mac ?? '')
    .toLowerCase()
    .split(/[:-]/)
    .filter(Boolean);
  const hex =
    fields.length >= 6 && fields.slice(0, 6).every((f) => /^[0-9a-f]{1,2}$/.test(f))
      ? fields
          .slice(0, 6)
          .map((f) => f.padStart(2, '0'))
          .join('')
      : String(mac ?? '')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .slice(0, 32);
  const base = hex && !/^0+$/.test(hex) ? hex : `ip-${String(host ?? '').toLowerCase()}`;
  return `${base.replace(/[^a-z0-9-]/g, '-').slice(0, 40)}-${validPort(port)}`;
}
