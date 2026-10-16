// -----------------------------------------------------------------------------
// The live link to one created player: two long-poll loops (API §2), no
// polling clock.
//
// - /Status (playback, now playing) and /SyncStatus (name, volume, mute,
//   group) each have a loop: a plain read first, then the same request with
//   the etag of the last answer and `timeout`: the player answers as soon as
//   something changes, else after the timeout (100 s and 180 s, the values
//   of the document). Two loops, because /Status of a secondary player of a
//   group is its primary's: only its /SyncStatus follows its own volume.
// - A failed poll is retried after 5 s, 10 s, 20 s... up to 2 minutes, with
//   a plain read (a stale etag would hold the request); two failures in a
//   row make the player offline, one answer makes it online again.
// - With the commands of src/bluos/client.js (one at a time), a player sees
//   at most three requests from Gladys at once.
// -----------------------------------------------------------------------------

import { LONG_POLL, PACING } from './constants.js';

const defaultTimers = { setTimeout, clearTimeout };

export class PlayerLink {
  /**
   * player: { externalId, name, host, port }; client: a BluosClient;
   * onUpdate(link, kind): an answer arrived ('status' | 'sync');
   * onOnline(link, online): the player came back or went offline.
   */
  constructor({ player, client, logger, timers = defaultTimers, onUpdate, onOnline }) {
    this.player = player;
    this.client = client;
    this.logger = logger;
    this.timers = timers;
    this.onUpdate = onUpdate ?? (async () => {});
    this.onOnline = onOnline ?? (async () => {});
    this.status = undefined;
    this.sync = undefined;
    /** undefined until the first answer or the first offline verdict */
    this.online = undefined;
    this.failures = { status: 0, sync: 0 };
    /** false: the next poll of that kind is a plain read */
    this.fresh = { status: false, sync: false };
    /** the loops run (start) / the link is done for good (stop) */
    this.running = false;
    this.stopped = false;
    this.loops = [];
    this.waits = new Set();
  }

  get endpoint() {
    return `${this.player.host}:${this.player.port}`;
  }

  start() {
    if (this.running || this.stopped) {
      return;
    }
    this.running = true;
    this.loops = ['status', 'sync'].map((kind) => this.loop(kind));
  }

  /** Stop the loops and cancel the polls in flight. */
  stop() {
    this.running = false;
    this.stopped = true;
    this.client.close();
    for (const wait of this.waits) {
      this.timers.clearTimeout(wait.timer);
      wait.resolve();
    }
    this.waits.clear();
    return Promise.all(this.loops);
  }

  async loop(kind) {
    while (this.running && !this.stopped) {
      await this.pollOnce(kind);
    }
  }

  /** A pause that ends early when the link stops. */
  wait(ms) {
    return new Promise((resolve) => {
      const wait = { resolve };
      wait.timer = this.timers.setTimeout(() => {
        this.waits.delete(wait);
        resolve();
      }, ms);
      this.waits.add(wait);
    });
  }

  backoff(failures) {
    return Math.min(PACING.BACKOFF_MAX, PACING.BACKOFF_BASE * 2 ** Math.max(0, failures - 1));
  }

  /** One poll of `kind`; never throws. */
  async pollOnce(kind) {
    const last = kind === 'status' ? this.status : this.sync;
    const etag = this.fresh[kind] && last?.etag ? last.etag : undefined;
    try {
      const answer =
        kind === 'status'
          ? await this.client.status({ etag, timeout: LONG_POLL.STATUS })
          : await this.client.syncStatus({ etag, timeout: LONG_POLL.SYNC });
      if (this.stopped) {
        return;
      }
      this.failures[kind] = 0;
      this.fresh[kind] = true;
      if (kind === 'status') {
        this.status = answer;
      } else {
        this.sync = answer;
      }
      await this.setOnline(true);
      await this.onUpdate(this, kind);
    } catch (err) {
      if (this.stopped || err?.code === 'aborted') {
        return;
      }
      this.fresh[kind] = false;
      this.failures[kind] += 1;
      if (err?.unreachable && this.failures[kind] >= PACING.OFFLINE_AFTER) {
        await this.setOnline(false, err);
      } else {
        this.logger?.debug?.(`${this.player.name}: /${kind} failed (${err?.message})`);
      }
      await this.wait(this.backoff(this.failures[kind]));
    }
  }

  async setOnline(online, err) {
    if (this.online === online) {
      return;
    }
    const before = this.online;
    this.online = online;
    if (online && before === false) {
      this.logger?.info?.(`${this.player.name} answers again`);
    } else if (!online) {
      this.logger?.info?.(
        `${this.player.name} is offline (${err?.message ?? 'no answer'}); trying again with backoff`,
      );
      // The next answer is a plain read: forget what the player said before.
      this.fresh = { status: false, sync: false };
    }
    await this.onOnline(this, online);
  }
}
