// -----------------------------------------------------------------------------
// A fake BluOS player: the requests of the integration, answered from a small
// state, in the shape of the recorded answers (test/fixtures/recorded) and of
// the API document. Long polls are held until the state changes, the test
// times them out (`timeoutPolls`) or the integration cancels them.
//
// `createTransport(players)` plugs players into a BluosClient (no network);
// `serve(player)` puts one behind a real HTTP server (loopback tests, e2e).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { BluosError } from '../../src/bluos/errors.js';

const esc = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const el = (name, value) =>
  value === undefined || value === null ? '' : `<${name}>${esc(value)}</${name}>`;

export const DEFAULT_PRESETS = [
  {
    id: 1,
    name: 'FIP',
    url: 'TuneIn:s15200/http://opml.radiotime.com/Tune.ashx?id=s15200',
  },
  { id: 2, name: 'Radio Paradise Main Mix', url: 'RadioParadise:/0:4' },
  { id: 5, name: 'Jazz du dimanche', url: '/Load?service=Qobuz&id=4512870' },
];

export const DEFAULT_INPUTS = [
  {
    id: 'input1',
    text: 'Optical Input',
    inputType: 'spdif',
    url: 'Capture:hw:imxspdif,0/1/25/2?id=input1',
  },
  { id: 'input3', text: 'HDMI ARC', inputType: 'arc', url: 'Capture:hw:imxarc,0/1/25/2?id=input3' },
  { id: 'input2', text: 'Bluetooth', inputType: 'bluetooth', url: 'Capture:bluez:bluetooth' },
];

const ok = (text) => ({ status: 200, text });

export class FakePlayer {
  constructor({
    host = '192.168.4.10',
    port = 11000,
    mac = '90:56:82:0A:00:01',
    name = 'Amplifier',
    brand = 'NAD',
    model = 'C658',
    modelName = 'C658',
    version = '4.16.6',
    volume = 41,
    presets = DEFAULT_PRESETS,
    inputs = DEFAULT_INPUTS,
    playing = {},
  } = {}) {
    Object.assign(this, { host, port, mac, name, brand, model, modelName, version });
    this.volume = volume;
    this.muteVolume = undefined;
    this.fixedVolume = false;
    this.presets = presets;
    this.inputs = inputs;
    this.prid = 4;
    this.leader = null;
    this.followers = [];
    this.now = {
      state: 'pause',
      name: 'So What',
      artist: 'Miles Davis',
      album: 'Kind of Blue',
      service: 'Qobuz',
      fn: 'Qobuz:59954988',
      song: 3,
      secs: 94,
      totlen: 562,
      streamUrl: undefined,
      inputId: undefined,
      actions: [],
      ...playing,
    };
    this.statusEtag = 1;
    this.syncEtag = 1;
    this.offline = false;
    /** every request: { path, query } */
    this.requests = [];
    this.waiters = { status: [], sync: [] };
    /** path -> { status, text } answered once instead of the normal answer */
    this.next = new Map();
  }

  get endpoint() {
    return `${this.host}:${this.port}`;
  }

  // --- State changes (as the BluOS app or the remote would make them) ------------

  /** What plays changed: the /Status etag moves and its long polls answer. */
  setPlaying(patch) {
    Object.assign(this.now, patch);
    this.bump('status');
  }

  /** Volume, name or group changed: both resources move (/Status carries syncStat). */
  setSync(patch = {}) {
    Object.assign(this, patch);
    this.bump('sync');
    this.bump('status');
  }

  bump(kind) {
    if (kind === 'status') this.statusEtag += 1;
    else this.syncEtag += 1;
    const waiters = this.waiters[kind];
    this.waiters[kind] = [];
    for (const w of waiters) w.resolve();
  }

  /** The long polls in flight answer unchanged (their timeout elapsed). */
  timeoutPolls() {
    for (const kind of ['status', 'sync']) {
      const waiters = this.waiters[kind];
      this.waiters[kind] = [];
      for (const w of waiters) w.resolve();
    }
  }

  /** Go offline: the polls in flight fail like a dropped connection. */
  unplug() {
    this.offline = true;
    for (const kind of ['status', 'sync']) {
      const waiters = this.waiters[kind];
      this.waiters[kind] = [];
      for (const w of waiters) w.reject(new BluosError('network', 'network error (ECONNRESET)'));
    }
  }

  plugIn() {
    this.offline = false;
  }

  held(kind) {
    return this.waiters[kind].length;
  }

  count(path) {
    return this.requests.filter((r) => r.path === path).length;
  }

  // --- Answers ---------------------------------------------------------------------

  statusXml() {
    const n = this.now;
    const actions = n.actions?.length
      ? `<actions>${n.actions
          .map((a) => `<action name="${esc(a.name)}"${a.url ? ` url="${esc(a.url)}"` : ''}/>`)
          .join('')}</actions>`
      : '';
    return [
      `<status etag="${this.statusEtag}">`,
      actions,
      el('album', n.album),
      el('artist', n.artist),
      el('fn', n.fn),
      el('inputId', n.inputId),
      el('mute', this.muteVolume !== undefined ? 1 : 0),
      el('name', n.name),
      el('prid', this.prid),
      el('service', n.service),
      el('song', n.song),
      el('state', n.state),
      el('streamUrl', n.streamUrl),
      el('syncStat', this.syncEtag),
      el('title1', n.title1 ?? n.name),
      el('title2', n.title2 ?? n.artist),
      el('title3', n.title3 ?? n.album),
      el('totlen', n.totlen),
      el('volume', this.fixedVolume ? -1 : this.volume),
      el('secs', n.secs),
      '</status>',
    ].join('');
  }

  syncXml() {
    const attrs = [
      `etag="${this.syncEtag}"`,
      `syncStat="${this.syncEtag}"`,
      `version="${esc(this.version)}"`,
      `id="${esc(this.endpoint)}"`,
      `volume="${this.fixedVolume ? -1 : this.volume}"`,
      ...(this.muteVolume !== undefined ? [`muteVolume="${this.muteVolume}"`] : []),
      `name="${esc(this.name)}"`,
      `model="${esc(this.model)}"`,
      `modelName="${esc(this.modelName)}"`,
      `brand="${esc(this.brand)}"`,
      'initialized="true"',
      ...(this.followers.length
        ? [`group="${esc([this.name, ...this.followers.map((f) => f.name)].join('+'))}"`]
        : []),
      `mac="${esc(this.mac)}"`,
    ];
    const children = [
      ...(this.leader
        ? [`<master port="${this.leader.port}">${esc(this.leader.host)}</master>`]
        : []),
      ...this.followers.map(
        (f) => `<slave id="${esc(f.host)}" port="${f.port}" name="${esc(f.name ?? '')}"></slave>`,
      ),
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<SyncStatus ${attrs.join(' ')}>${children.join('')}</SyncStatus>`;
  }

  volumeXml() {
    const muted = this.muteVolume !== undefined;
    return `<volume db="-40" mute="${muted ? 1 : 0}"${muted ? ` muteVolume="${this.muteVolume}"` : ''} etag="v${this.syncEtag}">${this.fixedVolume ? -1 : this.volume}</volume>`;
  }

  presetsXml() {
    return `<presets prid="${this.prid}">${this.presets
      .map((p) => `<preset id="${p.id}" name="${esc(p.name)}" url="${esc(p.url)}"/>`)
      .join('')}</presets>`;
  }

  captureXml() {
    return `<radiotime service="Capture">${this.inputs
      .map(
        (i) =>
          `<item text="${esc(i.text)}" inputType="${esc(i.inputType)}" id="${esc(i.id)}" URL="${esc(encodeURIComponent(i.url))}" type="audio"/>`,
      )
      .join('')}</radiotime>`;
  }

  hold(kind, signal) {
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => resolve(ok(kind === 'status' ? this.statusXml() : this.syncXml())),
        reject,
      };
      this.waiters[kind].push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          this.waiters[kind] = this.waiters[kind].filter((w) => w !== waiter);
          reject(new BluosError('aborted', 'cancelled'));
        },
        { once: true },
      );
    });
  }

  /** One request: path with its query -> { status, text }. */
  async handle(pathWithQuery, { signal } = {}) {
    if (this.offline) {
      throw new BluosError('network', 'network error (EHOSTUNREACH)');
    }
    const url = new URL(pathWithQuery, 'http://player');
    const q = Object.fromEntries(url.searchParams);
    this.requests.push({ path: url.pathname, query: q, raw: pathWithQuery });
    if (this.next.has(url.pathname)) {
      const answer = this.next.get(url.pathname);
      this.next.delete(url.pathname);
      return answer;
    }
    switch (url.pathname) {
      case '/Status':
        if (q.etag && q.etag === String(this.statusEtag)) return this.hold('status', signal);
        return ok(this.statusXml());
      case '/SyncStatus':
        if (q.etag && q.etag === String(this.syncEtag)) return this.hold('sync', signal);
        return ok(this.syncXml());
      case '/Volume':
        if (this.fixedVolume) return ok(this.volumeXml());
        if (q.level !== undefined) {
          this.volume = Math.max(0, Math.min(100, Number(q.level)));
          this.muteVolume = undefined;
          this.setSync();
        } else if (q.mute === '1' && this.muteVolume === undefined) {
          this.muteVolume = this.volume;
          this.volume = 0;
          this.setSync();
        } else if (q.mute === '0' && this.muteVolume !== undefined) {
          this.volume = this.muteVolume;
          this.muteVolume = undefined;
          this.setSync();
        }
        return ok(this.volumeXml());
      case '/Play':
        if (q.url) {
          const input = this.inputs.find((i) => i.url === q.url);
          if (input) {
            this.setPlaying({
              state: 'stream',
              inputId: input.id,
              streamUrl: q.url,
              fn: q.url,
              service: 'Capture',
              name: undefined,
              artist: undefined,
              album: undefined,
              title1: input.text,
              title2: '',
              title3: '',
            });
          } else {
            this.setPlaying({
              state: 'stream',
              inputId: undefined,
              streamUrl: q.url,
              fn: q.url,
              service: 'WebRadio',
              name: undefined,
              artist: undefined,
              album: undefined,
              title1: q.url.split('/').at(-1),
              title2: '',
              title3: '',
            });
          }
          return ok('<state>stream</state>');
        }
        if (q.id !== undefined) {
          this.setPlaying({
            state: 'play',
            song: Number(q.id),
            secs: Number(q.seek ?? 0),
            streamUrl: undefined,
            inputId: undefined,
            fn: `Qobuz:${q.id}`,
            service: 'Qobuz',
          });
          return ok('<state>play</state>');
        }
        this.setPlaying({ state: this.now.streamUrl ? 'stream' : 'play' });
        return ok(`<state>${this.now.state}</state>`);
      case '/Pause': {
        const playing = this.now.state === 'play' || this.now.state === 'stream';
        this.setPlaying({ state: q.toggle === '1' && !playing ? 'play' : 'pause' });
        return ok(`<state>${this.now.state}</state>`);
      }
      case '/Stop':
        this.setPlaying({ state: 'stop' });
        return ok('<state>stop</state>');
      case '/Skip':
        this.setPlaying({ song: (this.now.song ?? 0) + 1 });
        return ok(`<id>${this.now.song}</id>`);
      case '/Back':
        this.setPlaying({ song: Math.max(0, (this.now.song ?? 0) - 1) });
        return ok(`<id>${this.now.song}</id>`);
      case '/Action':
        return ok('<skip/>');
      case '/Preset': {
        const preset = this.presets.find((p) => String(p.id) === q.id);
        if (!preset) return ok('<error><message>No such preset</message></error>');
        this.setPlaying({
          state: 'stream',
          inputId: undefined,
          streamUrl: preset.url,
          fn: preset.url,
          service: 'TuneIn',
          name: undefined,
          artist: undefined,
          album: undefined,
          title1: preset.name,
          title2: 'Live',
          title3: '',
        });
        return ok('<state>stream</state>');
      }
      case '/Presets':
        return ok(this.presetsXml());
      case '/RadioBrowse':
        return q.service === 'Capture' ? ok(this.captureXml()) : { status: 404, text: '' };
      case '/AddSlave': {
        const follower = { host: q.slave, port: Number(q.port ?? 11000), name: q.name ?? q.slave };
        if (!this.followers.some((f) => f.host === follower.host && f.port === follower.port)) {
          this.followers.push(follower);
        }
        this.setSync();
        return ok(
          `<addSlave>${this.followers.map((f) => `<slave port="${f.port}" id="${esc(f.host)}"/>`).join('')}</addSlave>`,
        );
      }
      case '/RemoveSlave':
        this.followers = this.followers.filter(
          (f) => !(f.host === q.slave && f.port === Number(q.port ?? 11000)),
        );
        this.setSync();
        return ok(this.syncXml());
      default:
        return { status: 404, text: '<html>Not found</html>' };
    }
  }
}

export const createPlayer = (options) => new FakePlayer(options);

/** A BluosClient transport answered by the players (unknown address: unreachable). */
export function createTransport(players) {
  return async ({ host, port, path, signal }) => {
    const player = players.find((p) => p.host === host && p.port === port);
    if (!player) {
      throw new BluosError('network', 'network error (EHOSTUNREACH)');
    }
    return player.handle(path, { signal });
  };
}

/** The player behind a real HTTP server on 127.0.0.1 (random port). */
export async function serve(player) {
  const server = http.createServer((req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    player
      .handle(req.url, { signal: controller.signal })
      .then(({ status, text }) => {
        res.writeHead(status, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(text);
      })
      .catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Let the pending promises and their continuations run. */
export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
