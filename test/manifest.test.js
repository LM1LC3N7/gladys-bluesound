// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BOUNDS, DEFAULTS } from '../src/config.js';
import {
  ACTIONS,
  INPUT_TYPES,
  MDNS_SERVICES,
  PLAYBACK_COMMANDS,
  PLAYBACK_STATES,
  SCENE_ACTIONS,
  SCENE_TRIGGERS,
  SOURCE_KINDS,
} from '../src/constants.js';
import { sceneEvents } from '../src/triggers.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const byKey = (list, key) => list.find((item) => item.key === key);
const keys = (list) => (list ?? []).map((item) => item.key);

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, />=5\.1\.0/, 'scene declarations need 5.1');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-bluesound:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-bluesound');
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['multimedia']);
  assert.equal(manifest.location, undefined, 'no house location needed');
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /non officiel/);
  assert.match(manifest.config_schema[0].description.en, /not affiliated with Lenbrook/);
  // The API use policy of Lenbrook: "works with BluOS", never their marks as the name.
  assert.match(manifest.name, /\(works with BluOS\)$/);
  assert.ok(manifest.name.length <= 30, 'the store allows 30 characters');
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('discovery asks the core for the mDNS services of the players', () => {
  assert.deepEqual(
    manifest.network_discovery,
    MDNS_SERVICES.map((service) => ({ type: 'mdns', service })),
  );
  assert.ok(handlers.includes('onScanRequest('));
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.equal(fields.notification_volume.min, BOUNDS.notification_volume.min);
  assert.equal(fields.notification_volume.max, BOUNDS.notification_volume.max);
  assert.deepEqual(keys(manifest.config_schema), ['intro', ...Object.keys(DEFAULTS)]);
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  assert.deepEqual(keys(manifest.scene_actions).sort(), Object.values(SCENE_ACTIONS).sort());
  assert.deepEqual(keys(manifest.scene_triggers).sort(), Object.values(SCENE_TRIGGERS).sort());
  assert.equal(manifest.widgets, undefined);
  for (const name of Object.keys(SCENE_ACTIONS)) {
    assert.ok(handlers.includes(`onSceneAction(SCENE_ACTIONS.${name}`), name);
  }
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
});

test('trigger filters are the values the events carry', () => {
  const options = (trigger, field) =>
    byKey(byKey(manifest.scene_triggers, trigger).fields, field).options.map((o) => o.value);
  assert.deepEqual(options(SCENE_TRIGGERS.PLAYBACK, 'state'), PLAYBACK_STATES);
  assert.deepEqual(options(SCENE_TRIGGERS.SOURCE, 'kind'), SOURCE_KINDS);
  assert.deepEqual(options(SCENE_TRIGGERS.SOURCE, 'input_type'), INPUT_TYPES);
  const playback = byKey(manifest.scene_actions, SCENE_ACTIONS.PLAYBACK);
  assert.deepEqual(
    byKey(playback.fields, 'command').options.map((o) => o.value),
    PLAYBACK_COMMANDS,
  );
  // Every field and variable of a trigger is a key of its event.
  const events = sceneEvents({
    deviceId: 'ext:bluos:player:x-11000',
    name: 'Salon',
    reading: { online: true, playback: 'playing', source: { kind: 'input', name: 'TV' } },
    previous: { playback: 'paused', sourceName: 'Qobuz' },
    changes: ['playback', 'source', 'track'],
  });
  for (const trigger of manifest.scene_triggers) {
    const event = events.find((e) => e.key === trigger.key);
    for (const key of keys([...trigger.fields, ...trigger.variables])) {
      assert.ok(key in event.data, `${trigger.key}.${key} is not in the event`);
    }
    assert.ok(Object.keys(event.data).length <= 30);
  }
});

test('the outputs the scene actions return (checked by test/app.test.js)', () => {
  const outputs = (key) => keys(byKey(manifest.scene_actions, key).outputs);
  assert.deepEqual(outputs(SCENE_ACTIONS.PLAYBACK), []);
  assert.deepEqual(outputs(SCENE_ACTIONS.PLAY_PRESET), ['preset', 'preset_name']);
  assert.deepEqual(outputs(SCENE_ACTIONS.SELECT_SOURCE), ['source', 'kind']);
  assert.deepEqual(outputs(SCENE_ACTIONS.PLAY_URL), ['resumable']);
  assert.deepEqual(outputs(SCENE_ACTIONS.GROUP_ADD), ['group_size']);
  assert.deepEqual(outputs(SCENE_ACTIONS.GROUP_REMOVE), ['was_grouped']);
  assert.deepEqual(outputs(SCENE_ACTIONS.NOW_PLAYING), [
    'online',
    'playing',
    'state',
    'title',
    'artist',
    'album',
    'summary',
    'source',
    'kind',
    'volume',
    'muted',
    'group',
  ]);
  for (const action of manifest.scene_actions) {
    const player = byKey(action.fields, 'player');
    assert.equal(player.source, 'devices', `${action.key}.player`);
    assert.equal(player.required, true, `${action.key}.player`);
  }
});
