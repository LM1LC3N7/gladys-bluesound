// -----------------------------------------------------------------------------
// The answers of a player -> plain values (pure).
//
// Written from Lenbrook's "BluOS Custom Integration API" v1.7 and checked
// against pyblu (the library of the Home Assistant integration, MIT) and the
// answers recorded on real players by homebridge-bluos (Apache-2.0):
// - /SyncStatus never carries a `mute` attribute: a muted player is the one
//   that reports `muteVolume` (the level to return to);
// - /Status of a secondary player of a group is a copy of its primary's:
//   the volume and mute of a player come from its own /SyncStatus;
// - the `mac` of the secondary zones of a multi-zone chassis (CI580, CI S2)
//   carries the zone port as a seventh field: a player is `mac + port`;
// - `zoneMaster="true"` inside <zoneOptions> is a stereo-pairing option, not
//   a group: only the <master> and <slave> children say who groups with whom.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT } from '../constants.js';
import { BluosError } from './errors.js';
import { childOf, childText, childrenOf, parseXml, textOf } from './xml.js';

const int = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

const num = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const port = (value) => {
  const n = int(value);
  return n !== undefined && n > 0 && n < 65536 ? n : DEFAULT_PORT;
};

const bounded = (text, max = 200) => String(text ?? '').slice(0, max);

/** The text of an <error> answer, with its details. */
function errorMessage(root) {
  const message = childText(root, 'message') || textOf(root).trim() || 'the player refused';
  const details = childrenOf(root, 'detail')
    .map((d) => textOf(d).trim())
    .filter(Boolean);
  return bounded(details.length ? `${message}: ${details.join('; ')}` : message);
}

/**
 * The root element of an answer. An <error> root is the player refusing the
 * request; `expected` lists the root names the request can answer.
 */
export function rootOf(text, expected) {
  let root;
  try {
    root = parseXml(text);
  } catch (err) {
    throw new BluosError('answer', `unreadable answer (${err.message})`);
  }
  if (root.name === 'error') {
    throw new BluosError('refused', errorMessage(root));
  }
  if (expected && !expected.includes(root.name)) {
    throw new BluosError('answer', `unexpected answer <${bounded(root.name, 40)}>`);
  }
  return root;
}

/** /Status: playback and now playing. */
export function parseStatus(text) {
  const root = rootOf(text, ['status']);
  const t = (name) => childText(root, name);
  const actions = childrenOf(childOf(root, 'actions'), 'action')
    .map((a) => ({ name: String(a.attrs.name ?? ''), url: String(a.attrs.url ?? '') }))
    .filter((a) => a.name);
  return {
    etag: String(root.attrs.etag ?? ''),
    state: (t('state') ?? '').toLowerCase(),
    title1: t('title1') ?? '',
    title2: t('title2') ?? '',
    title3: t('title3') ?? '',
    name: t('name') ?? '',
    artist: t('artist') ?? '',
    album: t('album') ?? '',
    service: t('service') ?? '',
    fn: t('fn') ?? '',
    inputId: t('inputId') ?? '',
    // A flag, its content is opaque: the play queue is not the source.
    streamUrl: t('streamUrl'),
    image: t('image') ?? '',
    volume: int(t('volume')),
    mute: t('mute') === '1',
    syncStat: t('syncStat') ?? '',
    prid: t('prid') ?? '',
    song: int(t('song')),
    secs: num(t('secs')),
    totlen: num(t('totlen')),
    groupName: t('groupName') ?? '',
    actions,
  };
}

/** /SyncStatus (also the answer of /RemoveSlave): identity, volume, grouping. */
export function parseSyncStatus(text) {
  const root = rootOf(text, ['SyncStatus']);
  const a = root.attrs;
  const master = childOf(root, 'master');
  const battery = childOf(root, 'battery');
  const volume = int(a.volume);
  return {
    etag: String(a.etag ?? ''),
    syncStat: String(a.syncStat ?? ''),
    // "ip:port", the address the player gives itself (what /AddSlave needs).
    id: String(a.id ?? ''),
    mac: String(a.mac ?? ''),
    name: bounded(String(a.name ?? '').trim(), 100),
    brand: bounded(a.brand, 60),
    model: bounded(a.model, 60),
    modelName: bounded(a.modelName, 60),
    version: bounded(a.version, 40),
    volume: volume !== undefined && volume >= 0 && volume <= 100 ? volume : undefined,
    fixedVolume: volume === -1,
    muted: a.muteVolume !== undefined || a.mute === '1',
    muteVolume: int(a.muteVolume),
    group: bounded(a.group, 200),
    leader: master ? { host: textOf(master).trim(), port: port(master.attrs.port) } : null,
    followers: childrenOf(root, 'slave')
      .map((s) => ({
        host: String(s.attrs.id ?? ''),
        port: port(s.attrs.port),
        name: s.attrs.name ?? '',
      }))
      .filter((s) => s.host),
    initialized: a.initialized !== 'false',
    battery: battery
      ? {
          level: int(battery.attrs.level),
          charging: battery.attrs.charging === '1' || battery.attrs.charging === 'true',
        }
      : null,
  };
}

/** /Volume: the level is the text of the root, the mute an attribute. */
export function parseVolume(text) {
  const root = rootOf(text, ['volume']);
  const volume = int(textOf(root).trim());
  return {
    volume: volume !== undefined && volume >= 0 && volume <= 100 ? volume : undefined,
    fixedVolume: volume === -1,
    muted: root.attrs.mute === '1',
  };
}

/** /Presets, sorted by id. */
export function parsePresets(text) {
  const root = rootOf(text, ['presets']);
  const presets = childrenOf(root, 'preset')
    .map((p) => ({
      id: int(p.attrs.id),
      name: bounded(String(p.attrs.name ?? '').trim(), 100),
      url: String(p.attrs.url ?? ''),
    }))
    .filter((p) => p.id !== undefined);
  presets.sort((x, y) => x.id - y.id);
  return { prid: String(root.attrs.prid ?? ''), presets };
}

const decoded = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * /RadioBrowse?service=Capture: the inputs and the sources a player can
 * switch to (its own items, and the <remoteitem> of a BluOS Hub). The URL
 * comes percent-encoded: kept decoded, encoded again when sent.
 */
export function parseInputs(text) {
  const root = rootOf(text, ['radiotime']);
  const items = [
    ...childrenOf(root, 'item'),
    ...childrenOf(root, 'category').flatMap((c) => childrenOf(c, 'remoteitem')),
  ];
  const inputs = [];
  const seen = new Set();
  for (const item of items) {
    const url = decoded(String(item.attrs.URL ?? item.attrs.url ?? ''));
    const id = String(item.attrs.id ?? '') || url;
    if (!url || seen.has(id)) {
      continue;
    }
    seen.add(id);
    inputs.push({
      id: bounded(id, 100),
      name: bounded(String(item.attrs.text ?? '').trim(), 100) || bounded(id, 100),
      inputType: String(item.attrs.inputType ?? '').toLowerCase(),
      url,
    });
  }
  return inputs;
}

/** /AddSlave: the secondary players the group now has (a refused one is missing). */
export function parseAddSlave(text) {
  const root = rootOf(text, ['addSlave']);
  return childrenOf(root, 'slave')
    .map((s) => ({ host: String(s.attrs.id ?? ''), port: port(s.attrs.port) }))
    .filter((s) => s.host);
}

/** The answer of a command: <state>, <id>, <loaded>, <addSlave>... anything but <error>. */
export function parseCommand(text) {
  if (!String(text ?? '').trim()) {
    return { name: '', text: '' };
  }
  const root = rootOf(text);
  return { name: root.name, text: textOf(root).trim(), attrs: root.attrs };
}

// --- Readings ---------------------------------------------------------------------

/** play / stream -> playing, pause -> paused, stop -> stopped; else null (connecting...). */
export function playbackOf(state) {
  switch (state) {
    case 'play':
    case 'stream':
    case 'playing':
      return 'playing';
    case 'pause':
    case 'paused':
      return 'paused';
    case 'stop':
    case 'stopped':
      return 'stopped';
    default:
      return null;
  }
}

/**
 * Title, artist and album: the dedicated elements, else the three display
 * lines (a radio station only fills the lines).
 */
export function nowPlayingOf(status) {
  return {
    title: status?.name || status?.title1 || '',
    artist: status?.artist || status?.title2 || '',
    album: status?.album || status?.title3 || '',
  };
}

/** The one-line "now playing" (the document asks UIs to use title1-3). */
export function nowPlayingLine(status) {
  const lines = [status?.title1, status?.title2, status?.title3].filter(Boolean);
  const text = lines.length ? lines : Object.values(nowPlayingOf(status)).filter(Boolean);
  return bounded([...new Set(text)].join(' — '), 300);
}

/**
 * What the player plays from:
 *   { kind: 'input', key: 'input:<id>', name, inputType }
 *   { kind: 'preset', key: 'preset:<id>', name }
 *   { kind: 'service', key: 'service:<id>', name }
 * or null. An input by its id (the Capture list names it); a preset when the
 * stream is the preset's URL (Home Assistant does the same); else the service.
 */
export function sourceOf(status, { presets = [], inputs = [] } = {}) {
  if (!status) {
    return null;
  }
  if (status.inputId) {
    const input = inputs.find((i) => i.id === status.inputId);
    return {
      kind: 'input',
      key: `input:${status.inputId}`,
      name: input?.name ?? status.inputId,
      inputType: input?.inputType ?? '',
    };
  }
  if (status.streamUrl) {
    const input = inputs.find((i) => i.url === status.streamUrl);
    if (input) {
      return {
        kind: 'input',
        key: `input:${input.id}`,
        name: input.name,
        inputType: input.inputType,
      };
    }
    const preset = presets.find((p) => p.url === status.streamUrl);
    if (preset) {
      return { kind: 'preset', key: `preset:${preset.id}`, name: preset.name, inputType: '' };
    }
  }
  if (status.service) {
    const id = status.service
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40);
    return { kind: 'service', key: `service:${id}`, name: status.service, inputType: '' };
  }
  return null;
}

/** The streaming-radio action named `name` (skip, back) when the status offers one. */
export function actionUrl(status, name) {
  const action = (status?.actions ?? []).find((a) => a.name === name);
  // Only a path on the player itself: never another host.
  return action?.url && action.url.startsWith('/') && !action.url.startsWith('//')
    ? action.url
    : undefined;
}
