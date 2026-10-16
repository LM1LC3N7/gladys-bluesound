// -----------------------------------------------------------------------------
// One BluOS player (one host:port): the requests of the Custom Integration
// API this integration uses, as plain HTTP GETs on the LAN.
//
// Pace (API §2 and what it implies):
// - never two requests for the same resource (/Status, /Volume...) less than
//   a second apart: each request reserves its slot before it is sent;
// - commands and plain reads run one at a time (`exclusive`), so a player
//   sees at most three requests from Gladys at once: its two long polls
//   (/Status, /SyncStatus, see src/player.js) and one command;
// - `close()` cancels everything in flight (stop, new address).
// -----------------------------------------------------------------------------

import {
  DEFAULT_PORT,
  HTTP_TIMEOUT,
  LONG_POLL,
  SAME_RESOURCE_GAP,
  SLOW_TIMEOUT,
} from '../constants.js';
import { BluosError } from './errors.js';
import { httpGet } from './http.js';
import {
  parseAddSlave,
  parseCommand,
  parseInputs,
  parsePresets,
  parseStatus,
  parseSyncStatus,
  parseVolume,
} from './model.js';

const encodeQuery = (query) =>
  Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');

export class BluosClient {
  constructor({
    host,
    port = DEFAULT_PORT,
    transport = httpGet,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.host = host;
    this.port = port;
    this.transport = transport;
    this.now = now;
    this.sleep = sleep;
    /** resource -> the time its last request was (or will be) sent */
    this.slots = new Map();
    this.queue = Promise.resolve();
    this.controller = new AbortController();
  }

  get endpoint() {
    return `${this.host}:${this.port}`;
  }

  /** Cancel every request in flight and refuse the next ones. */
  close() {
    this.controller.abort();
  }

  get closed() {
    return this.controller.signal.aborted;
  }

  /** Run `job` after the commands before it (one at a time per player). */
  exclusive(job) {
    const result = this.queue.then(() => job());
    this.queue = result.catch(() => {});
    return result;
  }

  /** Wait for the slot of `resource`: a second after the previous request for it. */
  async spaced(resource) {
    const now = this.now();
    const at = Math.max(now, (this.slots.get(resource) ?? -Infinity) + SAME_RESOURCE_GAP);
    this.slots.set(resource, at);
    if (at > now) {
      await this.sleep(at - now);
    }
  }

  /** GET path?query -> the answer text (HTTP 200 only). */
  async get(path, query = {}, { timeout = HTTP_TIMEOUT, rawPath } = {}) {
    if (this.closed) {
      throw new BluosError('aborted', 'cancelled');
    }
    await this.spaced(path);
    if (this.closed) {
      throw new BluosError('aborted', 'cancelled');
    }
    const qs = encodeQuery(query);
    const { status, text } = await this.transport({
      host: this.host,
      port: this.port,
      path: rawPath ?? (qs ? `${path}?${qs}` : path),
      timeout,
      signal: this.controller.signal,
    });
    if (status !== 200) {
      throw new BluosError('status', `HTTP ${status}`, { status });
    }
    return text;
  }

  // --- Long polls (src/player.js runs one loop of each) --------------------------

  /** /Status; with an etag, held up to `timeout` seconds until something changes. */
  async status({ etag, timeout = LONG_POLL.STATUS } = {}) {
    const poll = etag ? { timeout, etag } : {};
    const deadline = etag ? timeout * 1000 + LONG_POLL.GRACE : HTTP_TIMEOUT;
    return parseStatus(await this.get('/Status', poll, { timeout: deadline }));
  }

  /** /SyncStatus, the same way. */
  async syncStatus({ etag, timeout = LONG_POLL.SYNC } = {}) {
    const poll = etag ? { timeout, etag } : {};
    const deadline = etag ? timeout * 1000 + LONG_POLL.GRACE : HTTP_TIMEOUT;
    return parseSyncStatus(await this.get('/SyncStatus', poll, { timeout: deadline }));
  }

  // --- Plain reads, one at a time with the commands ------------------------------

  readStatus() {
    return this.exclusive(() => this.status());
  }

  readSyncStatus() {
    return this.exclusive(() => this.syncStatus());
  }

  presets() {
    return this.exclusive(async () => parsePresets(await this.get('/Presets')));
  }

  /** The inputs and sources of /RadioBrowse?service=Capture (API §11.1). */
  inputs() {
    return this.exclusive(async () =>
      parseInputs(await this.get('/RadioBrowse', { service: 'Capture' })),
    );
  }

  // --- Commands ------------------------------------------------------------------

  command(path, query = {}, options = {}) {
    return this.exclusive(async () => parseCommand(await this.get(path, query, options)));
  }

  /** Level 0-100; `tellSlaves` also moves the players grouped under this one. */
  setVolume(level, { tellSlaves = false } = {}) {
    return this.exclusive(async () =>
      parseVolume(await this.get('/Volume', { level, tell_slaves: tellSlaves ? 1 : 0 })),
    );
  }

  /** mute=1 mutes (API §3.4; the parameter table of §3.1 says the opposite, the players do not). */
  setMute(muted, { tellSlaves = false } = {}) {
    return this.exclusive(async () =>
      parseVolume(
        await this.get('/Volume', { mute: muted ? 1 : 0, tell_slaves: tellSlaves ? 1 : 0 }),
      ),
    );
  }

  /** Resume the current audio (a paused one: a stopped stream does not resume). */
  play() {
    return this.command('/Play');
  }

  /** Play a stream URL, or an input / source URL of the Capture list (API §4.1, §11.1). */
  playUrl(url) {
    return this.command('/Play', { url }, { timeout: SLOW_TIMEOUT });
  }

  /** Play track `id` of the play queue from `seek` seconds (API §4.1, BluOS 4.0+). */
  playTrack({ id, seek }) {
    return this.command('/Play', { seek: Math.max(0, Math.floor(seek ?? 0)), id });
  }

  pause({ toggle = false } = {}) {
    return this.command('/Pause', toggle ? { toggle: 1 } : {});
  }

  stop() {
    return this.command('/Stop');
  }

  skip() {
    return this.command('/Skip');
  }

  back() {
    return this.command('/Back');
  }

  /** A streaming-radio action (skip, back) of /Status: a path on this player, sent as given. */
  action(url) {
    if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) {
      return Promise.reject(new BluosError('answer', 'invalid action'));
    }
    const path = url.split('?')[0];
    return this.command(path, {}, { rawPath: url });
  }

  loadPreset(id) {
    return this.command('/Preset', { id }, { timeout: SLOW_TIMEOUT });
  }

  /** Group the player at host:port under this one (API §8.1); -> the followers now. */
  addFollower({ host, port = DEFAULT_PORT }) {
    return this.exclusive(async () =>
      parseAddSlave(await this.get('/AddSlave', { slave: host, port }, { timeout: SLOW_TIMEOUT })),
    );
  }

  /** Take the player at host:port out of this one's group (API §8.3); -> the SyncStatus. */
  removeFollower({ host, port = DEFAULT_PORT }) {
    return this.exclusive(async () =>
      parseSyncStatus(
        await this.get('/RemoveSlave', { slave: host, port }, { timeout: SLOW_TIMEOUT }),
      ),
    );
  }
}
