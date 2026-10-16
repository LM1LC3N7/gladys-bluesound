// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and fake players, through the
// exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BluesoundApp } from '../src/app.js';
import { playerIdOf } from '../src/bluos/discovery.js';
import { ACTIONS, PACING, SCENE_ACTIONS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { createPlayer, createTransport, settle } from './helpers/fakePlayer.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-16T08:00:00Z');
const idOf = (p) => `ext:bluos:player:${playerIdOf({ mac: p.mac, host: p.host, port: p.port })}`;

/** A player device as Gladys hands it back once created. */
const created = (p, { host = p.host } = {}) => ({
  external_id: idOf(p),
  name: p.name,
  params: [
    { name: 'host', value: host },
    { name: 'port', value: String(p.port) },
  ],
  features: [],
});

const mdnsOf = (p) => ({
  name: `${p.name}._musc._tcp.local`,
  host: `${p.name}.local`,
  addresses: [p.host],
  port: p.port,
  txt: [],
});

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({ players = [createPlayer()], devices, config = {}, mdns } = {}) {
  const gladys = createFakeGladys({
    selector: 'bluos',
    config,
    devices: devices ?? players.map((p) => created(p)),
    scanResults: { mdns: mdns ?? players.map(mdnsOf) },
  });
  const timers = createFakeTimers();
  const clock = { now: T0 };
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.join(' ')}`),
    ]),
  );
  const app = new BluesoundApp({
    gladys,
    logger,
    now: () => clock.now,
    timers,
    transport: createTransport(players),
    sleep: async () => {},
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  await settle();
  running = app;
  const player = players[0];
  const id = player ? idOf(player) : undefined;
  return {
    app,
    gladys,
    players,
    player,
    id,
    f: (key, of = id) => `${of}:${key}`,
    timers,
    clock,
    logs,
    events: (key) => gladys.fake.sceneEvents.filter((e) => !key || e.key === key),
    device: (p = player) => gladys.fake.devices.find((d) => d.external_id === idOf(p)),
  };
}

const feature = (externalId) => ({ external_id: externalId });

/** The commands a player received: no poll, no list. */
const commands = (p) =>
  p.requests
    .filter((r) => !['/Status', '/SyncStatus', '/Presets', '/RadioBrowse'].includes(r.path))
    .map((r) => r.raw);

test('discovery: the players answering mDNS and the typed addresses, read once each', async () => {
  const salon = createPlayer();
  const zone = createPlayer({
    host: '192.168.4.11',
    port: 11010,
    mac: '90:56:82:0A:00:02:11010',
    name: 'Zone Two',
    model: 'CI-S2',
    modelName: 'CI S2',
  });
  const { gladys, logs } = await setup({
    players: [salon, zone],
    devices: [],
    config: { hosts: '192.168.4.11:11010, 192.168.4.99' },
    mdns: [mdnsOf(salon), mdnsOf(salon), { ...mdnsOf(salon), addresses: ['8.8.8.8'] }],
  });
  assert.deepEqual(gladys.fake.scans, [{ type: 'mdns', timeout_seconds: 5 }]);
  const devices = gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => [d.external_id, d.name]),
    [
      ['ext:bluos:player:9056820a0001-11000', 'Amplifier'],
      ['ext:bluos:player:9056820a0002-11010', 'Zone Two'],
    ],
  );
  const source = devices[0].features.find((x) => x.external_id.endsWith(':source'));
  assert.deepEqual(
    source.supported_options.map((o) => o.label),
    [
      'Optical Input',
      'HDMI ARC',
      'Bluetooth',
      '1. FIP',
      '2. Radio Paradise Main Mix',
      '5. Jazz du dimanche',
    ],
  );
  assert.ok(logs.some((l) => /No player read at 192\.168\.4\.99:11000/.test(l)));
  assert.match(gladys.fake.connectionStatus.message.en, /No player yet/);
  // Each candidate was read once.
  assert.equal(salon.count('/SyncStatus'), 1);
});

test('discovery without mDNS still reads the typed addresses', async () => {
  const { gladys, app, logs } = await setup({ devices: [], config: { hosts: '192.168.4.10' } });
  gladys.scanNetwork = async () => {
    throw new Error('403 not declared');
  };
  await gladys.fake.scanRequest();
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.ok(logs.some((l) => /mDNS scan unavailable/.test(l)));
  assert.equal(app.discovered.size, 1);
});

test('a created player: states at start, then only what changes, from the long polls', async () => {
  const { gladys, player, id, f } = await setup();
  assert.equal(gladys.fake.lastState(f('playback_state')), 0);
  assert.equal(gladys.fake.lastState(f('volume')), 41);
  assert.equal(gladys.fake.lastState(f('mute')), 0);
  assert.equal(gladys.fake.lastState(f('title')), 'So What');
  assert.equal(gladys.fake.lastState(f('artist')), 'Miles Davis');
  assert.equal(gladys.fake.lastState(f('source')), 'Qobuz');
  assert.equal(gladys.fake.lastState(f('group')), '—');
  assert.deepEqual(gladys.fake.transports, [{ device_external_id: id, transport: 'local' }]);
  assert.match(gladys.fake.connectionStatus.message.en, /1 player answers/);
  // Both resources are held by the player, nothing else polls.
  assert.equal(player.held('status'), 1);
  assert.equal(player.held('sync'), 1);
  const titles = () =>
    gladys.fake.states.filter((s) => s.device_feature_external_id === f('title'));
  player.setPlaying({ state: 'play' });
  await settle();
  assert.equal(gladys.fake.lastState(f('playback_state')), 1);
  assert.equal(titles().length, 1, 'an unchanged title is not sent again');
  player.setSync({ volume: 20 });
  await settle();
  assert.equal(gladys.fake.lastState(f('volume')), 20);
  player.timeoutPolls();
  await settle();
  assert.equal(player.held('status'), 1, 'polling again after a timeout');
});

test('scene events: playback, track and source; none for the first reading', async () => {
  const { player, events, clock } = await setup();
  assert.deepEqual(events(), []);
  player.setPlaying({ state: 'play' });
  await settle();
  player.setPlaying({ name: 'Freddie Freeloader', title1: 'Freddie Freeloader' });
  await settle();
  clock.now += 60_000;
  player.setPlaying({
    inputId: 'input1',
    streamUrl: 'Capture:hw:imxspdif,0/1/25/2?id=input1',
    service: 'Capture',
    state: 'stream',
    name: undefined,
    artist: undefined,
    album: undefined,
    title1: 'Optical Input',
    title2: '',
    title3: '',
  });
  await settle();
  assert.deepEqual(
    events().map((e) => e.key),
    ['playback_changed', 'track_changed', 'source_changed'],
  );
  const [playback, track, source] = events().map((e) => e.data);
  assert.equal(playback.state, 'playing');
  assert.equal(playback.previous_state, 'paused');
  assert.equal(playback.player_name, 'Amplifier');
  assert.equal(track.title, 'Freddie Freeloader');
  assert.equal(source.kind, 'input');
  assert.equal(source.input_type, 'spdif');
  assert.equal(source.source, 'Optical Input');
  assert.equal(source.previous_source, 'Qobuz');
});

test('commands sent through Gladys fire no scene event (no loop)', async () => {
  const { gladys, player, events, device, f, clock } = await setup();
  const ack = await gladys.fake.setValue(device(), feature(f('play')), 1);
  assert.deepEqual(ack, { success: true });
  await settle();
  assert.equal(player.now.state, 'play');
  assert.equal(gladys.fake.lastState(f('playback_state')), 1);
  assert.deepEqual(events(), []);
  clock.now += PACING.QUIET + 1;
  player.setPlaying({ state: 'pause' });
  await settle();
  assert.deepEqual(
    events().map((e) => e.data.state),
    ['paused'],
  );
});

test('setValue: transport, volume, mute toggle, source, read-only refused', async () => {
  const { gladys, player, device, f } = await setup();
  const set = (key, value) => gladys.fake.setValue(device(), feature(f(key)), value);
  await set('pause', 1);
  await set('next', 1);
  await set('previous', 1);
  await set('volume', 150);
  assert.equal(player.volume, 100);
  await settle();
  assert.equal(gladys.fake.lastState(f('volume')), 100);
  await set('mute', 1);
  await settle();
  assert.equal(gladys.fake.lastState(f('mute')), 1);
  await set('mute', 1);
  await settle();
  assert.equal(gladys.fake.lastState(f('mute')), 0, 'each press toggles');
  await set('source', 'input:input3');
  await set('source', 'preset:2');
  assert.deepEqual(commands(player), [
    '/Pause',
    '/Skip',
    '/Back',
    '/Volume?level=100&tell_slaves=0',
    '/Volume?mute=1&tell_slaves=0',
    '/Volume?mute=0&tell_slaves=0',
    '/Play?url=Capture%3Ahw%3Aimxarc%2C0%2F1%2F25%2F2%3Fid%3Dinput3',
    '/Preset?id=2',
  ]);
  await settle();
  assert.equal(gladys.fake.lastState(f('source')), 'preset:2');
  const refused = await set('title', 'x');
  assert.equal(refused.success, false);
  assert.match(refused.error, /title is read only/);
  const unknown = await gladys.fake.setValue(
    { external_id: 'ext:bluos:player:nope-1' },
    feature('x:play'),
    1,
  );
  assert.match(unknown.error, /Unknown player/);
});

test('next on a stream: through its action, refused without one; a fixed volume is refused', async () => {
  const player = createPlayer({
    playing: {
      state: 'stream',
      streamUrl: 'RadioParadise:/0:4',
      actions: [
        { name: 'back' },
        { name: 'skip', url: '/Action?service=RadioParadise&skip=8327661' },
      ],
    },
  });
  const { gladys, device, f } = await setup({ players: [player] });
  await gladys.fake.setValue(device(), feature(f('next')), 1);
  assert.equal(player.requests.at(-1).raw, '/Action?service=RadioParadise&skip=8327661');
  const back = await gladys.fake.setValue(device(), feature(f('previous')), 1);
  assert.equal(back.success, false);
  assert.match(back.error, /cannot go back/);
  player.setSync({ fixedVolume: true });
  await settle();
  const volume = await gladys.fake.setValue(device(), feature(f('volume')), 10);
  assert.match(volume.error, /fixed volume/);
});

test('the notification of Gladys: at its volume, then the volume and the queue come back', async () => {
  const player = createPlayer({ playing: { state: 'play' } });
  const { gladys, device, f, events } = await setup({
    players: [player],
    config: { notification_volume: 30 },
  });
  const url = 'https://gateway.gladysassistant.com/tts/abc.mp3';
  const ack = await gladys.fake.setValue(device(), feature(f('play_notification')), url);
  assert.deepEqual(ack, { success: true });
  await settle();
  assert.equal(player.volume, 30);
  assert.equal(player.now.streamUrl, url);
  player.setPlaying({ state: 'stop' });
  await settle();
  assert.deepEqual(commands(player), [
    '/Volume?level=30&tell_slaves=0',
    `/Play?url=${encodeURIComponent(url)}`,
    '/Volume?level=41&tell_slaves=0',
    '/Play?seek=94&id=3',
  ]);
  assert.equal(player.now.state, 'play');
  assert.deepEqual(events(), [], 'the announcement fires no scene event');
});

test('play_url: a preset radio comes back; resume off leaves it stopped', async () => {
  const player = createPlayer({
    playing: { state: 'stream', streamUrl: 'RadioParadise:/0:4', service: 'RadioParadise' },
  });
  const { gladys, id } = await setup({ players: [player] });
  const ack = await gladys.fake.sceneAction(SCENE_ACTIONS.PLAY_URL, {
    player: id,
    url: 'http://192.168.1.10/chime.mp3',
    resume: true,
  });
  assert.deepEqual(ack.data.outputs, { resumable: true });
  await settle();
  player.setPlaying({ state: 'stop' });
  await settle();
  assert.equal(commands(player).at(-1), '/Preset?id=2');
  const again = await gladys.fake.sceneAction(SCENE_ACTIONS.PLAY_URL, {
    player: id,
    url: 'http://192.168.1.10/chime.mp3',
    volume: 10,
    resume: false,
  });
  assert.deepEqual(again.data.outputs, { resumable: false });
  await settle();
  player.setPlaying({ state: 'stop' });
  await settle();
  assert.deepEqual(
    commands(player).slice(-3),
    [
      '/Volume?level=10&tell_slaves=0',
      '/Play?url=http%3A%2F%2F192.168.1.10%2Fchime.mp3',
      '/Volume?level=41&tell_slaves=0',
    ],
    'only the volume comes back',
  );
  const bad = await gladys.fake.sceneAction(SCENE_ACTIONS.PLAY_URL, {
    player: id,
    url: 'file:///etc/passwd',
  });
  assert.match(bad.error, /http:\/\/ or https:\/\//);
});

test('an announcement the user replaces resumes nothing; one that never starts gives back', async () => {
  const player = createPlayer({ playing: { state: 'play' } });
  const { gladys, id, timers, clock } = await setup({ players: [player] });
  await gladys.fake.sceneAction(SCENE_ACTIONS.PLAY_URL, { player: id, url: 'http://h/a.mp3' });
  await settle();
  player.setPlaying({
    state: 'stream',
    fn: 'Spotify:xyz',
    streamUrl: 'Spotify:xyz',
    service: 'Spotify',
  });
  await settle();
  player.setPlaying({ state: 'stop' });
  await settle();
  assert.equal(
    commands(player).at(-1),
    '/Play?url=http%3A%2F%2Fh%2Fa.mp3',
    'nothing after the user took over',
  );
  // Next: the URL never plays (the player keeps its state); the timer ends the watch.
  player.setPlaying({
    state: 'play',
    fn: 'Qobuz:59954988',
    streamUrl: undefined,
    service: 'Qobuz',
  });
  await settle();
  player.next.set('/Play', { status: 200, text: '<state>stream</state>' });
  await gladys.fake.sceneAction(SCENE_ACTIONS.PLAY_URL, { player: id, url: 'http://h/b.mp3' });
  clock.now += PACING.ANNOUNCE_START + 1_000;
  await timers.run((ms) => ms === PACING.ANNOUNCE_START + 1_000);
  await settle();
  assert.equal(commands(player).at(-1), '/Play?seek=94&id=3');
});

test('scene actions: presets and sources by number, name or word; unknown ones listed', async () => {
  const { gladys, id, player } = await setup();
  let ack = await gladys.fake.sceneAction(SCENE_ACTIONS.PLAY_PRESET, { player: id, preset: '5' });
  assert.deepEqual(ack.data.outputs, { preset: 5, preset_name: 'Jazz du dimanche' });
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.PLAY_PRESET, {
    player: id,
    preset: 'paradise',
  });
  assert.equal(ack.data.outputs.preset, 2);
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.PLAY_PRESET, { player: id, preset: '9' });
  assert.match(
    ack.error,
    /No preset "9".*1\. FIP, 2\. Radio Paradise Main Mix, 5\. Jazz du dimanche/,
  );
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.SELECT_SOURCE, { player: id, source: 'TV' });
  assert.deepEqual(ack.data.outputs, { source: 'HDMI ARC', kind: 'input' });
  assert.equal(player.now.inputId, 'input3');
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.SELECT_SOURCE, { player: id, source: 'fip' });
  assert.deepEqual(ack.data.outputs, { source: 'FIP', kind: 'preset' });
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.SELECT_SOURCE, { player: id, source: 'phono' });
  assert.match(ack.error, /Unknown source "phono".*Optical Input, HDMI ARC, Bluetooth, 1\. FIP/);
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.PLAYBACK, { player: id, command: 'stop' });
  assert.equal(ack.success, true);
  assert.equal(player.now.state, 'stop');
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.PLAYBACK, { player: id, command: 'toggle' });
  assert.equal(ack.success, true);
  assert.equal(player.now.state, 'play');
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.PLAYBACK, { player: id, command: 'eject' });
  assert.match(ack.error, /Unknown command/);
});

test('groups: join, leave as a secondary or a primary player, the group shown', async () => {
  const salon = createPlayer();
  const cuisine = createPlayer({ host: '192.168.4.12', mac: '90:56:82:0A:00:03', name: 'Cuisine' });
  const { gladys, f } = await setup({ players: [salon, cuisine] });
  const [a, b] = [idOf(salon), idOf(cuisine)];
  let ack = await gladys.fake.sceneAction(SCENE_ACTIONS.GROUP_ADD, { player: b, leader: a });
  assert.deepEqual(ack.data.outputs, { group_size: 2 });
  assert.equal(salon.requests.at(-1).raw, '/AddSlave?slave=192.168.4.12&port=11000');
  await settle();
  assert.equal(gladys.fake.lastState(f('group', a)), 'Amplifier+192.168.4.12');
  // The secondary player reports its primary.
  cuisine.setSync({ leader: { host: salon.host, port: salon.port } });
  await settle();
  assert.equal(gladys.fake.lastState(f('group', b)), 'Amplifier+192.168.4.12');
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.GROUP_REMOVE, { player: b });
  assert.deepEqual(ack.data.outputs, { was_grouped: true });
  assert.equal(salon.requests.at(-1).raw, '/RemoveSlave?slave=192.168.4.12&port=11000');
  cuisine.setSync({ leader: null });
  salon.setSync({ followers: [{ host: '192.168.4.12', port: 11000, name: 'Cuisine' }] });
  await settle();
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.GROUP_REMOVE, { player: a });
  assert.deepEqual(ack.data.outputs, { was_grouped: true });
  assert.equal(salon.requests.at(-1).raw, '/RemoveSlave?slave=192.168.4.10&port=11000');
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.GROUP_REMOVE, { player: b });
  assert.deepEqual(ack.data.outputs, { was_grouped: false });
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.GROUP_ADD, { player: a, leader: a });
  assert.match(ack.error, /cannot join itself/);
  salon.next.set('/AddSlave', { status: 200, text: '<addSlave></addSlave>' });
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.GROUP_ADD, { player: b, leader: a });
  assert.match(ack.error, /Cuisine did not join/);
});

test('now playing, for the following actions of a scene', async () => {
  const { gladys, id, player } = await setup();
  let ack = await gladys.fake.sceneAction(SCENE_ACTIONS.NOW_PLAYING, { player: id });
  assert.deepEqual(ack.data.outputs, {
    online: true,
    playing: false,
    state: 'paused',
    title: 'So What',
    artist: 'Miles Davis',
    album: 'Kind of Blue',
    summary: 'So What — Miles Davis — Kind of Blue',
    source: 'Qobuz',
    kind: 'service',
    volume: 41,
    muted: false,
    group: '',
  });
  player.unplug();
  await settle();
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.NOW_PLAYING, { player: id });
  assert.equal(
    ack.data.outputs.title,
    'So What',
    'the last known reading until offline is decided',
  );
});

test('offline: unreachable badge, not playing, a calm status; back online', async () => {
  const { gladys, player, id, f, timers } = await setup();
  player.setPlaying({ state: 'play' });
  await settle();
  player.unplug();
  await settle();
  await timers.run();
  await settle();
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: id,
    transport: 'unreachable',
  });
  assert.equal(gladys.fake.lastState(f('playback_state')), 0);
  assert.match(gladys.fake.connectionStatus.message.en, /0 of 1 players answer/);
  player.plugIn();
  await timers.run();
  await settle();
  assert.deepEqual(gladys.fake.transports.at(-1), { device_external_id: id, transport: 'local' });
  assert.equal(gladys.fake.lastState(f('playback_state')), 1);
  assert.match(gladys.fake.connectionStatus.message.en, /1 player answers/);
});

test('buttons: test the players and the typed addresses, list the sources', async () => {
  const other = createPlayer({ host: '192.168.4.13', mac: '90:56:82:0A:00:04', name: 'Bureau' });
  const salon = createPlayer();
  const { gladys, id } = await setup({
    players: [salon, other],
    devices: [created(salon)],
    config: { hosts: '192.168.4.13, 192.168.4.99' },
  });
  const test1 = await gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(
    test1.data.message.en,
    [
      'Amplifier (192.168.4.10:11000): paused, Qobuz, volume 41.',
      '192.168.4.13:11000: Bureau answers; add it from Discovery.',
      '192.168.4.99:11000: no BluOS player answers (network error (EHOSTUNREACH)).',
    ].join('\n'),
  );
  assert.match(test1.data.message.fr, /Amplifier \(192\.168\.4\.10:11000\) : en pause/);
  const list = await gladys.fake.action(ACTIONS.SOURCES, { player: id });
  assert.equal(
    list.data.message.en,
    [
      'Amplifier',
      'Sources:',
      '- Optical Input (spdif)',
      '- HDMI ARC (arc)',
      '- Bluetooth (bluetooth)',
      'Presets:',
      '1. FIP',
      '2. Radio Paradise Main Mix',
      '5. Jazz du dimanche',
    ].join('\n'),
  );
});

test('a new address: the link follows the device params', async () => {
  const player = createPlayer();
  const { gladys, f } = await setup({
    players: [player],
    devices: [created(player, { host: '192.168.4.200' })],
  });
  assert.equal(gladys.fake.lastState(f('title')), undefined, 'the old address does not answer');
  await gladys.fake.deviceUpdated(created(player));
  await settle();
  assert.equal(gladys.fake.lastState(f('title')), 'So What');
  await gladys.fake.deviceDeleted(created(player));
  await settle();
  assert.equal(player.held('status'), 0, 'a deleted device is not followed any more');
  assert.match(gladys.fake.connectionStatus.message.en, /No player yet/);
});

test('new presets reach the source list of the device, once', async () => {
  const { gladys, player, timers } = await setup();
  const before = gladys.fake.bodies('POST', '/discovered_device').length;
  player.presets = [...player.presets, { id: 9, name: 'France Musique', url: 'TuneIn:s15198' }];
  player.prid = 5;
  player.setPlaying({ state: 'play' });
  await settle();
  player.setPlaying({ state: 'pause' });
  await settle();
  assert.deepEqual(timers.delays(), [PACING.OPTIONS_DEBOUNCE]);
  await timers.run();
  await settle();
  const bodies = gladys.fake.bodies('POST', '/discovered_device');
  assert.equal(bodies.length, before + 1);
  const source = bodies.at(-1).devices[0].features.find((x) => x.external_id.endsWith(':source'));
  assert.equal(source.supported_options.at(-1).label, '9. France Musique');
});

test('a configuration change restarts, a disconnection stops the links', async () => {
  const { gladys, player, app } = await setup();
  await gladys.fake.configUpdated({ hosts: 'h/x' });
  await settle();
  assert.match(gladys.fake.connectionStatus.message.en, /position 1/);
  assert.equal(player.held('status'), 1);
  await app.stop();
  assert.equal(player.held('status'), 0);
});
