// -----------------------------------------------------------------------------
// The live link of a player: plain read then long polls, offline after two
// failures, backoff, back online, stop.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BluosClient } from '../src/bluos/client.js';
import { PlayerLink } from '../src/player.js';
import { createPlayer, createTransport, settle } from './helpers/fakePlayer.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

function setup() {
  const player = createPlayer();
  const timers = createFakeTimers();
  const client = new BluosClient({
    host: player.host,
    port: player.port,
    transport: createTransport([player]),
    sleep: async () => {},
  });
  const updates = [];
  const onlines = [];
  const link = new PlayerLink({
    player: { externalId: 'x', name: 'Amplifier', host: player.host, port: player.port },
    client,
    timers,
    onUpdate: async (_link, kind) => updates.push(kind),
    onOnline: async (_link, online) => onlines.push(online),
  });
  return { player, timers, link, updates, onlines };
}

test('a plain read, then the etag of the answer: held until something changes', async () => {
  const { player, link, updates, onlines } = setup();
  await link.pollOnce('status');
  await link.pollOnce('sync');
  assert.deepEqual(updates, ['status', 'sync']);
  assert.deepEqual(onlines, [true]);
  assert.equal(link.status.name, 'So What');
  assert.equal(link.sync.volume, 41);
  const held = link.pollOnce('status');
  await settle();
  assert.deepEqual(player.requests.at(-1).query, { timeout: '100', etag: '1' });
  player.setPlaying({ state: 'play' });
  await held;
  assert.equal(link.status.state, 'play');
  const heldSync = link.pollOnce('sync');
  await settle();
  assert.deepEqual(player.requests.at(-1).query, { timeout: '180', etag: '1' });
  player.timeoutPolls();
  await heldSync;
  assert.deepEqual(updates, ['status', 'sync', 'status', 'sync']);
});

test('offline after two failures in a row, backoff, back online with a plain read', async () => {
  const { player, timers, link, onlines } = setup();
  await link.pollOnce('status');
  const held = link.pollOnce('status');
  await settle();
  player.unplug();
  await settle();
  assert.deepEqual(timers.delays(), [5_000], 'first failure: 5 s');
  await timers.run();
  await held;
  assert.deepEqual(onlines, [true]);
  const second = link.pollOnce('status');
  await settle();
  assert.deepEqual(onlines, [true, false], 'second failure: offline');
  assert.deepEqual(timers.delays(), [10_000]);
  await timers.run();
  await second;
  for (let i = 0; i < 6; i += 1) {
    const p = link.pollOnce('status');
    await settle();
    await timers.run();
    await p;
  }
  assert.equal(link.backoff(link.failures.status), 120_000, 'capped at 2 minutes');
  player.plugIn();
  const back = link.pollOnce('status');
  await settle();
  await timers.run();
  await back;
  assert.deepEqual(onlines, [true, false, true]);
  assert.deepEqual(player.requests.at(-1).query, {}, 'a plain read after a failure');
});

test('an unexpected answer is retried without going offline', async () => {
  const { player, timers, link, onlines } = setup();
  player.next.set('/Status', { status: 200, text: '<html>busy</html>' });
  const p = link.pollOnce('status');
  await settle();
  await timers.run();
  await p;
  player.next.set('/Status', { status: 200, text: '<html>busy</html>' });
  const q = link.pollOnce('status');
  await settle();
  await timers.run();
  await q;
  assert.deepEqual(onlines, []);
  assert.equal(link.failures.status, 2);
});

test('start runs both loops; stop cancels the held polls and the backoff', async () => {
  const { player, link, updates } = setup();
  link.start();
  link.start();
  await settle();
  assert.deepEqual(updates.sort(), ['status', 'sync']);
  assert.equal(player.held('status'), 1);
  assert.equal(player.held('sync'), 1);
  await link.stop();
  assert.equal(player.held('status'), 0);
  assert.equal(player.held('sync'), 0);
  assert.equal(link.running, false);
});
