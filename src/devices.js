// -----------------------------------------------------------------------------
// The Gladys device of a player, its reading and its states. Pure.
//
// External id (forever):  player:<mac>-<port>  (see playerIdOf): the MAC of
// the player and its control port, so the zones of a multi-zone chassis,
// which share one MAC, stay apart.
//
// The features mirror the Sonos and Google Cast services of the Gladys core
// (category `music`: play, pause, previous, next, volume 0-100, playback
// state and play_notification), so a player works in the Music dashboard
// box and in the "play a notification" scene action like a Sonos. What the
// core music category has no type for: mute as `television` / `volume-mute`
// (a toggle button, like the author's Denon and Frontier Silicon
// integrations), the source as a `text` / `select` (inputs and presets),
// and the now playing and the group as read-only `text`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { DEFAULT_PORT } from './constants.js';
import { nowPlayingLine, nowPlayingOf, playbackOf, sourceOf } from './bluos/model.js';

export const FEATURE = {
  PLAY: 'play',
  PAUSE: 'pause',
  PREVIOUS: 'previous',
  NEXT: 'next',
  VOLUME: 'volume',
  PLAYBACK_STATE: 'playback_state',
  PLAY_NOTIFICATION: 'play_notification',
  MUTE: 'mute',
  SOURCE: 'source',
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  GROUP: 'group',
};

/** MUSIC_PLAYBACK_STATE of the Gladys core (server/utils/constants.js). */
export const MUSIC_PLAYBACK_STATE = { PLAYING: 1, PAUSED: 0 };

/** Shown by a text feature with nothing to say (an empty text is not a state). */
export const EMPTY_TEXT = '—';

/** At most this many entries in the source list. */
const MAX_OPTIONS = 100;

export const ids = {
  player: (gladys, playerId) => gladys.externalId(`player:${playerId}`),
  feature: (deviceId, key) => `${deviceId}:${key}`,
};

/** { kind: 'player', id } | undefined. */
export function parseExternalId(externalId) {
  const match = /:player:([a-z0-9-]{1,60})$/.exec(String(externalId ?? ''));
  return match ? { kind: 'player', id: match[1] } : undefined;
}

/** The feature key of a feature external id ("...:player:abc-11000:volume" -> "volume"). */
export const featureKey = (featureExternalId) => String(featureExternalId).split(':').at(-1);

const feature = (id, key, name, category, type, extra = {}) => ({
  name,
  external_id: ids.feature(id, key),
  category,
  type,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
  ...extra,
});

const text = (id, key, name) =>
  feature(id, key, name, C.TEXT, T.TEXT.TEXT, { max: 0, read_only: true });

/** The source list: the inputs of the Capture list, then the presets ("3. FIP"). */
export function sourceOptions({ presets = [], inputs = [] } = {}) {
  const options = [
    ...inputs.map((i) => ({ value: `input:${i.id}`, label: i.name })),
    ...presets.map((p) => ({ value: `preset:${p.id}`, label: `${p.id}. ${p.name || '?'}` })),
  ];
  const seen = new Set();
  return options
    .filter((o) => o.label.trim() && !seen.has(o.value) && seen.add(o.value))
    .slice(0, MAX_OPTIONS);
}

/**
 * A player device. `player` is what discovery read:
 *   { playerId, host, port, name, brand, model, modelName, version, presets, inputs }
 * The address lives in the params: a new address (DHCP) arrives with the
 * next Discovery scan, which updates the params of the created device.
 */
export function buildPlayerDevice(gladys, player) {
  const id = ids.player(gladys, player.playerId);
  const model = [player.brand, player.modelName || player.model].filter(Boolean).join(' ');
  return {
    name: player.name,
    external_id: id,
    features: [
      feature(id, FEATURE.PLAY, 'Play', C.MUSIC, T.MUSIC.PLAY),
      feature(id, FEATURE.PAUSE, 'Pause', C.MUSIC, T.MUSIC.PAUSE),
      feature(id, FEATURE.PREVIOUS, 'Previous', C.MUSIC, T.MUSIC.PREVIOUS),
      feature(id, FEATURE.NEXT, 'Next', C.MUSIC, T.MUSIC.NEXT),
      feature(id, FEATURE.VOLUME, 'Volume', C.MUSIC, T.MUSIC.VOLUME, {
        max: 100,
        has_feedback: true,
        keep_history: true,
      }),
      feature(id, FEATURE.PLAYBACK_STATE, 'Playback state', C.MUSIC, T.MUSIC.PLAYBACK_STATE, {
        read_only: true,
        keep_history: true,
      }),
      feature(
        id,
        FEATURE.PLAY_NOTIFICATION,
        'Play notification',
        C.MUSIC,
        T.MUSIC.PLAY_NOTIFICATION,
      ),
      feature(id, FEATURE.MUTE, 'Mute', C.TELEVISION, T.TELEVISION.VOLUME_MUTE, {
        has_feedback: true,
      }),
      feature(id, FEATURE.SOURCE, 'Source', C.TEXT, T.TEXT.SELECT, {
        has_feedback: true,
        supported_options: sourceOptions(player),
      }),
      text(id, FEATURE.TITLE, 'Title'),
      text(id, FEATURE.ARTIST, 'Artist'),
      text(id, FEATURE.ALBUM, 'Album'),
      text(id, FEATURE.GROUP, 'Group'),
    ],
    params: [
      { name: 'host', value: player.host },
      { name: 'port', value: String(player.port ?? DEFAULT_PORT) },
      { name: 'player_id', value: player.playerId },
      ...(model ? [{ name: 'model', value: model.slice(0, 100) }] : []),
      ...(player.version ? [{ name: 'firmware', value: player.version.slice(0, 40) }] : []),
    ],
  };
}

/** What the live link needs, from the device Gladys hands back. */
export function playerOfDevice(device) {
  const params = Object.fromEntries((device.params ?? []).map((p) => [p.name, p.value]));
  const host = String(params.host ?? '').trim();
  const port = Number(params.port);
  return {
    externalId: device.external_id,
    name: device.name || host,
    host,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
  };
}

/**
 * Everything Gladys shows of a player, from its last /Status and /SyncStatus:
 *   { online, playback, volume, muted, fixedVolume, source, title, artist,
 *     album, summary, group, role }
 * The volume and mute come from /SyncStatus (a secondary player's /Status
 * is its primary's), the rest from /Status.
 */
export function readingOf({ online, status, sync, presets = [], inputs = [], group = '' }) {
  if (!online || !status) {
    return { online: false, playback: null };
  }
  const role = sync?.leader ? 'follower' : sync?.followers?.length ? 'leader' : 'standalone';
  return {
    online: true,
    playback: playbackOf(status.state),
    volume: sync ? sync.volume : status.volume,
    muted: sync ? sync.muted : status.mute,
    fixedVolume: Boolean(sync?.fixedVolume),
    source: sourceOf(status, { presets, inputs }),
    ...nowPlayingOf(status),
    summary: nowPlayingLine(status),
    group,
    role,
  };
}

const number = (deviceId, key, value) =>
  value === null || value === undefined
    ? []
    : [{ device_feature_external_id: ids.feature(deviceId, key), state: value }];
const words = (deviceId, key, value) => [
  { device_feature_external_id: ids.feature(deviceId, key), text: value || EMPTY_TEXT },
];

/** The states of a reading. An offline player only says it does not play. */
export function playerStates(deviceId, reading, options = []) {
  if (!reading?.online) {
    return number(deviceId, FEATURE.PLAYBACK_STATE, MUSIC_PLAYBACK_STATE.PAUSED);
  }
  const playback =
    reading.playback === null
      ? null // connecting: the next answer tells
      : reading.playback === 'playing'
        ? MUSIC_PLAYBACK_STATE.PLAYING
        : MUSIC_PLAYBACK_STATE.PAUSED;
  const source = reading.source;
  // The select shows an option; a streaming service is not one: its name then.
  const sourceValue = source
    ? options.some((o) => o.value === source.key)
      ? source.key
      : source.name
    : '';
  return [
    ...number(deviceId, FEATURE.PLAYBACK_STATE, playback),
    ...number(deviceId, FEATURE.VOLUME, reading.fixedVolume ? null : reading.volume),
    ...number(deviceId, FEATURE.MUTE, reading.muted === undefined ? null : reading.muted ? 1 : 0),
    ...(sourceValue
      ? [{ device_feature_external_id: ids.feature(deviceId, FEATURE.SOURCE), text: sourceValue }]
      : []),
    ...words(deviceId, FEATURE.TITLE, reading.title),
    ...words(deviceId, FEATURE.ARTIST, reading.artist),
    ...words(deviceId, FEATURE.ALBUM, reading.album),
    ...words(deviceId, FEATURE.GROUP, reading.group),
  ];
}
