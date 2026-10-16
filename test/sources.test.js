// -----------------------------------------------------------------------------
// What a user types in a scene -> an input or a preset.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseInputs, parsePresets } from '../src/bluos/model.js';
import { findInput, findPreset, findSource, normalize } from '../src/sources.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const presets = parsePresets(fixture('presets.xml')).presets;
const inputs = parseInputs(fixture('capture.xml'));
const lists = { presets, inputs };

test('normalize: case, accents, punctuation', () => {
  assert.equal(normalize('  Préréglage   N°3 '), 'prereglage n 3');
  assert.equal(normalize('input:input1'), 'input:input1');
});

test('presets by number, by name, by a unique part of the name', () => {
  assert.equal(findPreset('2', presets).name, 'Radio Paradise Main Mix');
  assert.equal(findPreset('preset 5', presets).name, 'Jazz du dimanche');
  assert.equal(findPreset('Préréglage 7', presets).name, 'Platine vinyle');
  assert.equal(findPreset('preset:1', presets).name, 'FIP');
  assert.equal(findPreset('fip', presets).id, 1);
  assert.equal(findPreset('paradise', presets).id, 2);
  assert.equal(findPreset('3', presets), undefined, 'no preset 3');
  assert.equal(findPreset('', presets), undefined);
});

test('inputs by option value, name, everyday word and number', () => {
  assert.equal(findInput('input:input1', inputs).name, 'Optical Input');
  assert.equal(findInput('Optical Input', inputs).id, 'input1');
  assert.equal(findInput('optique', inputs).id, 'input1');
  assert.equal(findInput('TV', inputs).id, 'input3');
  assert.equal(findInput('hdmi', inputs).id, 'input3');
  assert.equal(findInput('aux', inputs).id, 'input0');
  assert.equal(findInput('vinyle', inputs).id, 'hub-192168414911000-input1');
  assert.equal(findInput('bluetooth', inputs).id, 'input2');
  assert.equal(findInput('optical 2', inputs), undefined, 'only one optical input');
  assert.equal(findInput('spot', inputs).id, 'Spotify');
  // eARC only: "tv" still finds it.
  assert.equal(findInput('tv', [{ id: 'e', name: 'TV', inputType: 'earc' }]).id, 'e');
});

test('a source: preset numbers, exact names, then words', () => {
  assert.deepEqual(findSource('3', lists), undefined);
  assert.equal(findSource('1', lists).preset.name, 'FIP');
  assert.equal(findSource('preset:5', lists).preset.id, 5);
  assert.equal(findSource('Optical', lists).input.id, 'input1');
  assert.equal(findSource('Platine vinyle', lists).preset.id, 7, 'an exact preset name');
  assert.equal(findSource('vinyl', lists).input.inputType, 'phono', 'the word: the phono input');
  assert.equal(findSource('jazz', lists).preset.id, 5);
  assert.equal(findSource('nothing like it', lists), undefined);
  assert.equal(findSource('', lists), undefined);
});
