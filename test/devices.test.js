// -----------------------------------------------------------------------------
// The Gladys device of a player, checked by the SDK's fake host API, and the
// states of a reading.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { parseInputs, parsePresets, parseStatus, parseSyncStatus } from '../src/bluos/model.js';
import {
  EMPTY_TEXT,
  FEATURE,
  buildPlayerDevice,
  parseExternalId,
  playerOfDevice,
  playerStates,
  readingOf,
  sourceOptions,
} from '../src/devices.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const presets = parsePresets(fixture('presets.xml')).presets;
const inputs = parseInputs(fixture('capture.xml'));

const player = {
  playerId: '9056820a0001-11000',
  host: '192.168.4.10',
  port: 11000,
  name: 'Amplifier',
  brand: 'NAD',
  model: 'C658',
  modelName: 'C658',
  version: '4.16.6',
  presets,
  inputs,
};

test('the device: Sonos-like music features, accepted by the host API', async () => {
  const gladys = createFakeGladys({ selector: 'bluos' });
  const device = buildPlayerDevice(gladys, player);
  assert.equal(device.external_id, 'ext:bluos:player:9056820a0001-11000');
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').at(-1)),
    Object.values(FEATURE),
  );
  const music = device.features.filter((f) => f.category === 'music').map((f) => f.type);
  assert.deepEqual(music, [
    'play',
    'pause',
    'previous',
    'next',
    'volume',
    'playback_state',
    'play_notification',
  ]);
  const volume = device.features.find((f) => f.type === 'volume');
  assert.deepEqual([volume.min, volume.max, volume.has_feedback], [0, 100, true]);
  const source = device.features.find((f) => f.external_id.endsWith(':source'));
  assert.equal(source.supported_options.length, 10);
  assert.deepEqual(source.supported_options[0], { value: 'input:input2', label: 'Bluetooth' });
  assert.deepEqual(source.supported_options.at(-1), {
    value: 'preset:7',
    label: '7. Platine vinyle',
  });
  assert.deepEqual(Object.fromEntries(device.params.map((p) => [p.name, p.value])), {
    host: '192.168.4.10',
    port: '11000',
    player_id: '9056820a0001-11000',
    model: 'NAD C658',
    firmware: '4.16.6',
  });
  await gladys.publishDiscoveredDevices([device]);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.deepEqual(parseExternalId(device.external_id), { kind: 'player', id: player.playerId });
  assert.deepEqual(playerOfDevice({ ...device, params: device.params }), {
    externalId: device.external_id,
    name: 'Amplifier',
    host: '192.168.4.10',
    port: 11000,
  });
  assert.equal(
    playerOfDevice({ external_id: 'x', params: [{ name: 'port', value: 'x' }] }).port,
    11000,
  );
});

test('the states of a reading, published by the host API', async () => {
  const gladys = createFakeGladys({ selector: 'bluos' });
  const id = 'ext:bluos:player:9056820a0001-11000';
  const status = parseStatus(fixture('status-input.xml'));
  const sync = parseSyncStatus(fixture('recorded/nad-c658.syncstatus.xml'));
  const reading = readingOf({ online: true, status, sync, presets, inputs, group: '' });
  const states = playerStates(id, reading, sourceOptions({ presets, inputs }));
  const byKey = Object.fromEntries(
    states.map((s) => [s.device_feature_external_id.split(':').at(-1), s.text ?? s.state]),
  );
  assert.deepEqual(byKey, {
    playback_state: 1,
    volume: 41,
    mute: 0,
    source: 'input:input1',
    title: 'Optical Input',
    artist: EMPTY_TEXT,
    album: EMPTY_TEXT,
    group: EMPTY_TEXT,
  });
  await gladys.publishStates(states);
  assert.equal(gladys.fake.lastState(`${id}:source`), 'input:input1');
});

test('volume and mute come from /SyncStatus: a follower keeps its own', () => {
  const status = parseStatus(fixture('status-queue-paused.xml'));
  const muted = parseSyncStatus(fixture('recorded/nad-ci-s2-zone-two-muted.syncstatus.xml'));
  const reading = readingOf({ online: true, status, sync: muted });
  assert.equal(reading.volume, 0);
  assert.equal(reading.muted, true);
  assert.equal(reading.playback, 'paused');
  const follower = parseSyncStatus(fixture('recorded/nad-ci-s2-group-follower.syncstatus.xml'));
  assert.equal(readingOf({ online: true, status, sync: follower }).role, 'follower');
  assert.equal(readingOf({ online: true, status, sync: follower }).volume, 60);
  const leader = parseSyncStatus(fixture('recorded/nad-ci-s2-group-leader.syncstatus.xml'));
  assert.equal(readingOf({ online: true, status, sync: leader }).role, 'leader');
});

test('a streaming service is shown by name; fixed volume and connecting publish nothing', () => {
  const status = parseStatus(fixture('status-radio.xml'));
  const reading = readingOf({
    online: true,
    status,
    sync: { volume: undefined, fixedVolume: true, muted: false, followers: [] },
  });
  const states = playerStates('d', reading, sourceOptions({ presets, inputs }));
  const keys = states.map((s) => s.device_feature_external_id.split(':').at(-1));
  assert.ok(!keys.includes('volume'));
  assert.equal(states.find((s) => s.device_feature_external_id === 'd:source').text, 'TuneIn');
  const connecting = playerStates('d', { ...reading, playback: null }, []);
  assert.ok(!connecting.some((s) => s.device_feature_external_id === 'd:playback_state'));
});

test('an offline player only says it does not play', () => {
  assert.deepEqual(playerStates('d', { online: false }), [
    { device_feature_external_id: 'd:playback_state', state: 0 },
  ]);
  assert.deepEqual(readingOf({ online: true }), { online: false, playback: null }, 'no status yet');
});
