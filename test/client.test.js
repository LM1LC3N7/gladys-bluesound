// -----------------------------------------------------------------------------
// One player's requests: query strings, the one-second rule, one command at a
// time, long polls, errors.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BluosClient } from '../src/bluos/client.js';
import { BluosError } from '../src/bluos/errors.js';
import { createPlayer, createTransport, settle } from './helpers/fakePlayer.js';

function setup(options = {}) {
  const player = createPlayer();
  const clock = { now: 1_000_000 };
  const sleeps = [];
  const client = new BluosClient({
    host: player.host,
    port: player.port,
    transport: createTransport([player]),
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    ...options,
  });
  return { player, client, clock, sleeps };
}

test('commands: paths and encoded parameters', async () => {
  const { player, client } = setup();
  await client.setVolume(35);
  await client.setMute(true);
  await client.playUrl('https://gladys.example/tts?text=Bonjour à tous&lang=fr');
  await client.playTrack({ id: 3, seek: 97.6 });
  assert.equal(player.now.streamUrl, undefined, 'the track of the queue plays');
  await client.loadPreset(5);
  await client.pause({ toggle: true });
  await client.stop();
  assert.deepEqual(
    player.requests.map((r) => r.raw),
    [
      '/Volume?level=35&tell_slaves=0',
      '/Volume?mute=1&tell_slaves=0',
      '/Play?url=https%3A%2F%2Fgladys.example%2Ftts%3Ftext%3DBonjour%20%C3%A0%20tous%26lang%3Dfr',
      '/Play?seek=97&id=3',
      '/Preset?id=5',
      '/Pause?toggle=1',
      '/Stop',
    ],
  );
});

test('never two requests for the same resource less than a second apart', async () => {
  const { client, sleeps } = setup();
  await client.setVolume(10);
  await client.setVolume(11);
  await client.play();
  await client.setVolume(12);
  // The second /Volume waits a second; /Play is another resource; the third
  // /Volume comes after the second's slot.
  assert.deepEqual(sleeps, [1000, 1000]);
});

test('commands run one at a time, even when sent together', async () => {
  const { player, client } = setup({ sleep: async () => {} });
  const order = [];
  const transport = createTransport([player]);
  let running = 0;
  client.transport = async (request) => {
    running += 1;
    assert.equal(running, 1, 'one request at a time');
    order.push(request.path);
    await settle(2);
    running -= 1;
    return transport(request);
  };
  await Promise.all([client.play(), client.skip(), client.readStatus(), client.presets()]);
  assert.deepEqual(order, ['/Play', '/Skip', '/Status', '/Presets']);
});

test('a long poll: etag and timeout, a deadline longer than the timeout', async () => {
  const { player, client } = setup();
  const seen = [];
  const transport = createTransport([player]);
  client.transport = (request) => {
    seen.push([request.path, request.timeout]);
    return transport(request);
  };
  const first = await client.status();
  const held = client.status({ etag: first.etag, timeout: 100 });
  await settle();
  assert.equal(player.held('status'), 1);
  player.setPlaying({ state: 'play' });
  assert.equal((await held).state, 'play');
  assert.deepEqual(seen, [
    ['/Status', 5_000],
    [`/Status?timeout=100&etag=${first.etag}`, 115_000],
  ]);
});

test('close() cancels a held long poll and refuses the next requests', async () => {
  const { player, client } = setup();
  const sync = await client.syncStatus();
  const held = client.syncStatus({ etag: sync.etag });
  await settle();
  client.close();
  await assert.rejects(held, (err) => err instanceof BluosError && err.code === 'aborted');
  await assert.rejects(client.play(), (err) => err.code === 'aborted');
  assert.equal(player.held('sync'), 0);
});

test('HTTP errors, refusals and the streaming actions', async () => {
  const { player, client } = setup();
  player.next.set('/Stop', { status: 500, text: '' });
  await assert.rejects(client.stop(), (err) => err.code === 'status' && err.status === 500);
  await assert.rejects(client.loadPreset(42), (err) => err.code === 'refused');
  await client.action('/Action?service=RadioParadise&skip=8327661');
  assert.equal(player.requests.at(-1).raw, '/Action?service=RadioParadise&skip=8327661');
  await assert.rejects(client.action('//evil/x'), (err) => err.code === 'answer');
  await assert.rejects(client.action('http://evil/x'), (err) => err.code === 'answer');
  player.unplug();
  await assert.rejects(client.readStatus(), (err) => err.unreachable && err.code === 'network');
});

test('lists and grouping', async () => {
  const { player, client } = setup();
  assert.deepEqual(
    (await client.presets()).presets.map((p) => p.id),
    [1, 2, 5],
  );
  assert.deepEqual(
    (await client.inputs()).map((i) => i.id),
    ['input1', 'input3', 'input2'],
  );
  const followers = await client.addFollower({ host: '192.168.4.11', port: 11010 });
  assert.deepEqual(followers, [{ host: '192.168.4.11', port: 11010 }]);
  assert.equal(player.requests.at(-1).raw, '/AddSlave?slave=192.168.4.11&port=11010');
  const sync = await client.removeFollower({ host: '192.168.4.11', port: 11010 });
  assert.deepEqual(sync.followers, []);
});
