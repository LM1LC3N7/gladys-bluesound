// -----------------------------------------------------------------------------
// Constants of the BluOS integration: protocol timings, limits and the
// manifest keys. The requests themselves live in src/bluos/client.js.
// -----------------------------------------------------------------------------

export const USER_AGENT = 'gladys-bluesound (+https://github.com/LM1LC3N7/gladys-bluesound)';

/** The control port of a player; the extra zones of a CI580 use 11010, 11020, 11030. */
export const DEFAULT_PORT = 11000;

/**
 * mDNS service types (API §1 and the LSDP table of its appendix): the players,
 * and the secondary zones of the multi-zone players (CI580, CI S2).
 */
export const MDNS_SERVICES = ['_musc._tcp', '_musp._tcp'];
/** Seconds the core listens for the mDNS answers. */
export const SCAN_TIMEOUT_SECONDS = 5;

/** A plain read or a command: the players answer within a second. */
export const HTTP_TIMEOUT = 5_000;
/** Loading a preset, a URL or an input, grouping: the player may take a few seconds. */
export const SLOW_TIMEOUT = 15_000;
/** An answer is a few KB; a long preset or input list some tens of KB. */
export const MAX_BYTES = 512 * 1024;

/**
 * Long polling (API §2): the player holds the request until its state changes
 * or `timeout` seconds pass. The document recommends 100 s for /Status (never
 * under 10 s) and 180 s for /SyncStatus. The HTTP deadline adds a margin: a
 * player unplugged mid-poll never closes the socket, the deadline does.
 */
export const LONG_POLL = { STATUS: 100, SYNC: 180, GRACE: 15_000 };

/** API §2: never two requests for the same resource less than a second apart. */
export const SAME_RESOURCE_GAP = 1_000;

export const PACING = {
  /** Consecutive failed polls before a player is called offline. */
  OFFLINE_AFTER: 2,
  /** Retry delay after a failed poll, doubled each time up to the max. */
  BACKOFF_BASE: 5_000,
  BACKOFF_MAX: 120_000,
  /** A change caused by a command sent through Gladys fires no scene event for this long. */
  QUIET: 10_000,
  /** The input list of a player, read again after half an hour... */
  INPUTS_TTL: 30 * 60_000,
  /** ...or when an unknown input plays, at most once a minute. */
  INPUTS_RETRY: 60_000,
  /** The automatic discovery at (re)connection, at most once an hour. */
  DISCOVERY_TTL: 60 * 60_000,
  /** New presets or inputs update the source list of the devices after this pause. */
  OPTIONS_DEBOUNCE: 10_000,
  /** An announcement that never starts playing is given up after this long... */
  ANNOUNCE_START: 20_000,
  /** ...and one that never ends after this long (the player is left as it is). */
  ANNOUNCE_MAX: 5 * 60_000,
};

/** Manual addresses accepted in the configuration. */
export const MAX_HOSTS = 20;

/** Manifest keys (forever: stored in user scenes and dashboards). */
export const ACTIONS = { TEST: 'test_connection', SOURCES: 'list_sources' };
export const SCENE_TRIGGERS = {
  PLAYBACK: 'playback_changed',
  SOURCE: 'source_changed',
  TRACK: 'track_changed',
};
export const SCENE_ACTIONS = {
  PLAYBACK: 'playback',
  PLAY_PRESET: 'play_preset',
  SELECT_SOURCE: 'select_source',
  PLAY_URL: 'play_url',
  GROUP_ADD: 'group_add',
  GROUP_REMOVE: 'group_remove',
  NOW_PLAYING: 'get_now_playing',
};

/** Values of the `state` field of playback_changed (forever). */
export const PLAYBACK_STATES = ['playing', 'paused', 'stopped'];
/** Values of the `kind` field of source_changed (forever). */
export const SOURCE_KINDS = ['input', 'preset', 'service'];
/** Values of the `input_type` field of source_changed: the input types of API §11.2. */
export const INPUT_TYPES = [
  'spdif',
  'analog',
  'coax',
  'bluetooth',
  'arc',
  'earc',
  'phono',
  'computer',
  'aesebu',
  'balanced',
  'microphone',
];
/** Values of the `command` field of the playback scene action (forever). */
export const PLAYBACK_COMMANDS = ['play', 'pause', 'toggle', 'stop', 'next', 'previous'];
