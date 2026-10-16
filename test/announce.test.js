// -----------------------------------------------------------------------------
// Announcements: what can be resumed, and when one ends.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contentOf, resumePlanOf, watchStep } from '../src/announce.js';
import { parseInputs, parsePresets, parseStatus } from '../src/bluos/model.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const inputs = parseInputs(fixture('capture.xml'));
const radio = parseStatus(fixture('status-radio.xml'));
const presets = parsePresets(fixture('presets.xml')).presets.map((p) =>
  p.id === 1 ? { ...p, url: radio.streamUrl } : p,
);
const LIMITS = { startTimeout: 20_000, maxDuration: 300_000 };

test('the play queue resumes at its track and second', () => {
  const queue = { ...parseStatus(fixture('status-queue-paused.xml')), state: 'play' };
  assert.deepEqual(resumePlanOf(queue, { presets, inputs }, { elapsedMs: 3_400 }), {
    kind: 'queue',
    id: 3,
    seek: 97,
  });
});

test('an input or a preset resumes; a stream outside them or a pause does not', () => {
  assert.deepEqual(resumePlanOf(parseStatus(fixture('status-input.xml')), { presets, inputs }), {
    kind: 'input',
    url: 'Capture:hw:imxspdif,0/1/25/2?id=input1',
    name: 'Optical Input',
  });
  assert.deepEqual(resumePlanOf(radio, { presets, inputs }), {
    kind: 'preset',
    id: 1,
    name: 'FIP',
  });
  assert.equal(resumePlanOf(radio, { presets: [], inputs }), null);
  assert.equal(resumePlanOf(parseStatus(fixture('status-queue-paused.xml')), {}), null);
  assert.equal(resumePlanOf(undefined), null);
});

test('the watch: started once something else plays, ended once it stops', () => {
  const before = {
    state: 'stream',
    fn: 'TuneIn:s15200',
    streamUrl: 'TuneIn:s15200',
    title1: 'FIP',
  };
  const tts = {
    state: 'stream',
    fn: 'https://g/tts.mp3',
    streamUrl: 'https://g/tts.mp3',
    title1: 'tts.mp3',
  };
  let announce = { before: contentOf(before), started: false, startedAt: 0 };
  let step = watchStep(announce, before, 1_000, LIMITS);
  assert.equal(step.done, null, 'still the old content');
  step = watchStep(step.announce, tts, 2_000, LIMITS);
  assert.equal(step.announce.started, true);
  step = watchStep(step.announce, { ...tts, title2: 'buffering' }, 3_000, LIMITS);
  assert.equal(step.done, null, 'a line of the same stream changed');
  step = watchStep(step.announce, { ...tts, state: 'stop' }, 9_000, LIMITS);
  assert.equal(step.done, 'ended');
  announce = step.announce;
  assert.equal(announce.started, true);
});

test('the watch: never started, replaced by the user, or too long', () => {
  const before = { state: 'play', fn: 'Qobuz:1', title1: 'So What' };
  const start = { before: contentOf(before), started: false, startedAt: 0 };
  assert.equal(watchStep(start, before, 25_000, LIMITS).done, 'not_started');
  const playing = watchStep(start, { state: 'stream', fn: 'https://x/a.mp3' }, 1_000, LIMITS);
  assert.equal(
    watchStep(
      playing.announce,
      { state: 'stream', fn: 'Spotify:abc', service: 'Spotify' },
      2_000,
      LIMITS,
    ).done,
    'replaced',
  );
  assert.equal(
    watchStep(playing.announce, { state: 'stream', fn: 'https://x/a.mp3' }, 301_000, LIMITS).done,
    'replaced',
  );
});
