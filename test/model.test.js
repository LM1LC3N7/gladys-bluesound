// -----------------------------------------------------------------------------
// The answers of the players -> values: the recorded answers of real players
// (test/fixtures/recorded) and the answers shaped after the API document.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BluosError } from '../src/bluos/errors.js';
import {
  actionUrl,
  nowPlayingLine,
  nowPlayingOf,
  parseAddSlave,
  parseCommand,
  parseInputs,
  parsePresets,
  parseStatus,
  parseSyncStatus,
  parseVolume,
  playbackOf,
  sourceOf,
} from '../src/bluos/model.js';
import { parseXml, textOf } from '../src/bluos/xml.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const recorded = (name) => fixture(`recorded/${name}`);

test('a standalone streamer (NAD C658, recorded)', () => {
  const sync = parseSyncStatus(recorded('nad-c658.syncstatus.xml'));
  assert.equal(sync.etag, '9');
  assert.equal(sync.id, '192.168.4.10:11000');
  assert.equal(sync.mac, '90:56:82:0A:00:01');
  assert.equal(sync.name, 'Amplifier');
  assert.equal(sync.brand, 'NAD');
  assert.equal(sync.modelName, 'C658');
  assert.equal(sync.version, '4.16.6');
  assert.equal(sync.volume, 41);
  assert.equal(sync.muted, false);
  assert.equal(sync.leader, null);
  assert.deepEqual(sync.followers, []);
  assert.equal(sync.battery, null);
});

test('mute is the presence of muteVolume, not a level of zero (recorded)', () => {
  const muted = parseSyncStatus(recorded('nad-ci-s2-zone-two-muted.syncstatus.xml'));
  assert.equal(muted.muted, true);
  assert.equal(muted.volume, 0);
  assert.equal(muted.muteVolume, 60);
  const zero = parseSyncStatus(recorded('nad-ci-s2-zone-two-level-zero.syncstatus.xml'));
  assert.equal(zero.muted, false);
  assert.equal(zero.volume, 0);
  // /Volume does carry the attribute.
  assert.deepEqual(parseVolume(recorded('nad-ci-s2-zone-two-muted.volume.xml')), {
    volume: 0,
    fixedVolume: false,
    muted: true,
  });
  assert.equal(parseVolume(recorded('nad-c658.volume.xml')).volume, 41);
});

test('the second zone of a chassis appends its port to the MAC (recorded)', () => {
  const one = parseSyncStatus(recorded('nad-ci-s2-zone-one.syncstatus.xml'));
  const two = parseSyncStatus(recorded('nad-ci-s2-zone-two.syncstatus.xml'));
  assert.equal(one.mac, '90:56:82:0A:00:02');
  assert.equal(two.mac, '90:56:82:0A:00:02:11010');
  assert.equal(two.id, '192.168.4.11:11010');
});

test('a group: the leader lists its followers, the follower names its leader (recorded)', () => {
  const leader = parseSyncStatus(recorded('nad-ci-s2-group-leader.syncstatus.xml'));
  assert.equal(leader.group, 'Zone Three+Zone Four');
  assert.deepEqual(leader.followers, [{ host: '192.168.4.14', port: 11010, name: 'Zone Four' }]);
  assert.equal(leader.leader, null);
  const follower = parseSyncStatus(recorded('nad-ci-s2-group-follower.syncstatus.xml'));
  assert.deepEqual(follower.leader, { host: '192.168.4.14', port: 11000 });
  assert.equal(follower.volume, 60, 'a follower keeps its own volume');
});

test('a stereo-pairing option is not a group; the battery is read (recorded)', () => {
  const paired = parseSyncStatus(recorded('bluesound-p125-zone-options.syncstatus.xml'));
  assert.equal(paired.leader, null);
  assert.deepEqual(paired.followers, []);
  const portable = parseSyncStatus(recorded('bluesound-p125-battery.syncstatus.xml'));
  assert.deepEqual(portable.battery, { level: 91, charging: false });
  assert.equal(
    parseSyncStatus(recorded('bluesound-p430-soundbar.syncstatus.xml')).name,
    'Soundbar',
  );
});

test('/Status of the play queue', () => {
  const status = parseStatus(fixture('status-queue-paused.xml'));
  assert.equal(status.etag, '5d2a1c0e9b8f7a6e4d3c2b1a09f8e7d6');
  assert.equal(status.state, 'pause');
  assert.equal(status.song, 3);
  assert.equal(status.secs, 94);
  assert.equal(status.streamUrl, undefined, 'the queue is the source');
  assert.equal(status.prid, '4');
  assert.equal(status.syncStat, '9');
  assert.equal(status.volume, 41);
  assert.deepEqual(nowPlayingOf(status), {
    title: 'So What',
    artist: 'Miles Davis',
    album: 'Kind of Blue (Legacy Edition)',
  });
  assert.equal(playbackOf(status.state), 'paused');
});

test('/Status of a radio: the three lines when there is no name nor artist', () => {
  const status = parseStatus(fixture('status-radio.xml'));
  assert.equal(status.state, 'stream');
  assert.equal(playbackOf(status.state), 'playing');
  assert.match(
    status.streamUrl,
    /^TuneIn:s15200\/http:\/\/opml\.radiotime\.com\/Tune\.ashx\?id=s15200&formats=/,
  );
  assert.deepEqual(nowPlayingOf(status), {
    title: 'FIP',
    artist: 'Herbie Hancock - Watermelon Man',
    album: 'FIP',
  });
  assert.equal(nowPlayingLine(status), 'FIP — Herbie Hancock - Watermelon Man');
});

test('the streaming-radio actions, and only paths on the player', () => {
  const status = parseStatus(fixture('status-stream-actions.xml'));
  assert.equal(actionUrl(status, 'skip'), '/Action?service=RadioParadise&skip=8327661');
  assert.equal(actionUrl(status, 'back'), undefined, 'back has no url here');
  assert.equal(actionUrl({ actions: [{ name: 'skip', url: '//evil/x' }] }, 'skip'), undefined);
  assert.equal(actionUrl({ actions: [{ name: 'skip', url: 'http://evil/x' }] }, 'skip'), undefined);
});

test('presets, sorted, with their URLs decoded', () => {
  const { prid, presets } = parsePresets(fixture('presets.xml'));
  assert.equal(prid, '4');
  assert.deepEqual(
    presets.map((p) => [p.id, p.name]),
    [
      [1, 'FIP'],
      [2, 'Radio Paradise Main Mix'],
      [5, 'Jazz du dimanche'],
      [7, 'Platine vinyle'],
    ],
  );
  assert.equal(presets[2].url, '/Load?service=Qobuz&id=4512870');
});

test('the Capture list: inputs, a cloud source and the inputs of a Hub', () => {
  const inputs = parseInputs(fixture('capture.xml'));
  assert.deepEqual(
    inputs.map((i) => [i.id, i.name, i.inputType]),
    [
      ['input2', 'Bluetooth', 'bluetooth'],
      ['input0', 'Analog Input', 'analog'],
      ['input1', 'Optical Input', 'spdif'],
      ['input3', 'HDMI ARC', 'arc'],
      ['Spotify', 'Spotify', ''],
      ['hub-192168414911000-input1', 'Phono Input', 'phono'],
    ],
  );
  assert.equal(inputs[2].url, 'Capture:hw:imxspdif,0/1/25/2?id=input1');
  assert.equal(inputs[5].url, 'Hub://192.168.4.149:11000/input1');
});

test('the source: an input, a preset, else the service', () => {
  const presets = parsePresets(fixture('presets.xml')).presets;
  const inputs = parseInputs(fixture('capture.xml'));
  assert.deepEqual(sourceOf(parseStatus(fixture('status-input.xml')), { presets, inputs }), {
    kind: 'input',
    key: 'input:input1',
    name: 'Optical Input',
    inputType: 'spdif',
  });
  // The radio plays the URL of preset 1.
  const radio = parseStatus(fixture('status-radio.xml'));
  const fip = { ...presets[0], url: radio.streamUrl };
  assert.deepEqual(sourceOf(radio, { presets: [fip], inputs }), {
    kind: 'preset',
    key: 'preset:1',
    name: 'FIP',
    inputType: '',
  });
  assert.deepEqual(sourceOf(radio, { presets: [], inputs }), {
    kind: 'service',
    key: 'service:tunein',
    name: 'TuneIn',
    inputType: '',
  });
  // An input not (yet) in the list keeps its id.
  assert.equal(sourceOf({ inputId: 'input9' }, { inputs }).name, 'input9');
  assert.equal(sourceOf({ service: '' }), null);
});

test('<error> is the player refusing; another root is an unexpected answer', () => {
  assert.throws(
    () => parseStatus('<error><message>Invalid preset</message><detail>id 9</detail></error>'),
    (err) =>
      err instanceof BluosError && err.code === 'refused' && err.message === 'Invalid preset: id 9',
  );
  assert.throws(
    () => parseSyncStatus('<status etag="1"/>'),
    (err) => err.code === 'answer',
  );
  assert.throws(
    () => parseStatus('not xml'),
    (err) => err.code === 'answer',
  );
  assert.deepEqual(parseCommand('<state>play</state>').text, 'play');
  assert.deepEqual(parseCommand(''), { name: '', text: '' });
  assert.deepEqual(parseAddSlave('<addSlave><slave port="11000" id="192.168.1.153"/></addSlave>'), [
    { host: '192.168.1.153', port: 11000 },
  ]);
});

test('playback states, tolerant of the spellings seen in the wild', () => {
  assert.equal(playbackOf('play'), 'playing');
  assert.equal(playbackOf('stream'), 'playing');
  assert.equal(playbackOf('pause'), 'paused');
  assert.equal(playbackOf('stop'), 'stopped');
  assert.equal(playbackOf('connecting'), null);
  assert.equal(playbackOf(''), null);
});

test('the XML parser: entities, CDATA, no expansion, bounded', () => {
  const root = parseXml(
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><r a="1&amp;2"><t><![CDATA[<b>]]> &a; &#233;</t></r>',
  );
  assert.equal(root.attrs.a, '1&2');
  assert.equal(textOf(root), '<b> &a; é');
  assert.throws(() => parseXml('<a>'.repeat(40)), /nested too deeply/);
  assert.throws(() => parseXml('just text'), /no XML element/);
});
