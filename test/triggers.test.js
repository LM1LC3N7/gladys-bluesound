// -----------------------------------------------------------------------------
// One scene event per transition.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneEvents, transition } from '../src/triggers.js';

const reading = (patch = {}) => ({
  online: true,
  playback: 'playing',
  source: { kind: 'service', key: 'service:qobuz', name: 'Qobuz', inputType: '' },
  title: 'So What',
  artist: 'Miles Davis',
  album: 'Kind of Blue',
  summary: 'So What — Miles Davis — Kind of Blue',
  ...patch,
});

/** Feed readings in order -> the changes of each. */
function run(readings, options = []) {
  let memory;
  return readings.map((r, i) => {
    const step = transition(memory, r, options[i]);
    memory = step.memory;
    return step.changes;
  });
}

test('the first reading only arms, and so does the first one after offline', () => {
  assert.deepEqual(
    run([
      reading(),
      reading({ playback: 'paused' }),
      { online: false },
      reading({ playback: 'playing' }),
    ]),
    [[], ['playback'], [], []],
  );
});

test('playing, paused, stopped; connecting changes nothing', () => {
  assert.deepEqual(
    run([
      reading({ playback: 'stopped' }),
      reading({ playback: null }),
      reading({ playback: 'playing' }),
      reading({ playback: 'playing' }),
      reading({ playback: 'stopped' }),
    ]),
    [[], [], ['playback'], [], ['playback']],
  );
});

test('another source fires source_changed, not track_changed', () => {
  const tv = { kind: 'input', key: 'input:input3', name: 'HDMI ARC', inputType: 'arc' };
  assert.deepEqual(
    run([
      reading(),
      reading({ source: tv, title: 'HDMI ARC', artist: '', album: '' }),
      reading({ source: null, title: '', artist: '', album: '' }),
    ]),
    [[], ['source'], []],
  );
});

test('a new track on the same source, while playing only', () => {
  assert.deepEqual(
    run([
      reading(),
      reading({ title: 'Freddie Freeloader' }),
      reading({ title: 'Blue in Green', playback: 'paused' }),
      reading({ title: '', artist: '', album: '', playback: 'paused' }),
    ]),
    [[], ['track'], ['playback'], []],
  );
});

test('quiet: a change made through Gladys arms silently', () => {
  assert.deepEqual(
    run(
      [reading(), reading({ playback: 'paused' }), reading({ playback: 'playing' })],
      [{}, { quiet: true }, {}],
    ),
    [[], [], ['playback']],
  );
});

test('the events: flat data with the declared keys', () => {
  const previous = { playback: 'paused', source: 'service:qobuz', sourceName: 'Qobuz', track: '' };
  const tv = { kind: 'input', key: 'input:input3', name: 'HDMI ARC', inputType: 'arc' };
  const events = sceneEvents({
    deviceId: 'ext:b:player:x-11000',
    name: 'Salon',
    reading: reading({ source: tv }),
    previous,
    changes: ['playback', 'source', 'track'],
  });
  assert.deepEqual(
    events.map((e) => e.key),
    ['playback_changed', 'source_changed', 'track_changed'],
  );
  assert.equal(events[0].data.state, 'playing');
  assert.equal(events[0].data.previous_state, 'paused');
  assert.equal(events[1].data.kind, 'input');
  assert.equal(events[1].data.input_type, 'arc');
  assert.equal(events[1].data.previous_source, 'Qobuz');
  assert.equal(events[2].data.player, 'ext:b:player:x-11000');
  for (const event of events) {
    for (const value of Object.values(event.data)) {
      assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value));
    }
  }
  const service = sceneEvents({
    deviceId: 'x',
    name: 'n',
    reading: reading(),
    changes: ['source'],
  });
  assert.equal(service[0].data.input_type, null, 'no input type: matches no input filter');
});
