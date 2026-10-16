// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, MAX_HOSTS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = {
  hosts: '',
  notification_volume: 0,
};

export const BOUNDS = { notification_volume: { min: 0, max: 100 } };

const number = (value, fallback, { min, max }) => {
  const n = Number(value);
  return value !== '' && value !== null && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
};

/**
 * The `hosts` field: addresses separated by commas, spaces or new lines,
 * each a host name or an IP with an optional port ("192.168.1.20",
 * "salon.lan:11000", "192.168.1.30:11010" for a second zone). An entry with
 * a path, credentials or another scheme than http is refused (reported by
 * its position only).
 *   -> { hosts: [{ host, port }], invalid: [positions] }
 */
export function parseHosts(text) {
  const hosts = [];
  const invalid = [];
  const seen = new Set();
  const entries = String(text ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean);
  entries.forEach((entry, index) => {
    let url;
    // "/path" would read as the host "path" (http:///path).
    if (entry.startsWith('/')) {
      invalid.push(index + 1);
      return;
    }
    try {
      url = new URL(/^[a-z]+:\/\//i.test(entry) ? entry : `http://${entry}`);
    } catch {
      invalid.push(index + 1);
      return;
    }
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash ||
      !url.hostname
    ) {
      invalid.push(index + 1);
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // new URL() drops the default port 80: an explicit ":80" is a mistake for a player.
    const port = url.port ? Number(url.port) : /:80$/.test(entry) ? 80 : DEFAULT_PORT;
    const key = `${host.toLowerCase()}:${port}`;
    if (!seen.has(key) && hosts.length < MAX_HOSTS) {
      seen.add(key);
      hosts.push({ host, port });
    }
  });
  return { hosts, invalid };
}

export function normalizeConfig(raw = {}) {
  const { hosts, invalid } = parseHosts(raw.hosts ?? DEFAULTS.hosts);
  return {
    hosts,
    invalidHosts: invalid,
    notificationVolume: number(
      raw.notification_volume,
      DEFAULTS.notification_volume,
      BOUNDS.notification_volume,
    ),
  };
}
