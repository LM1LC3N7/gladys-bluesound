// -----------------------------------------------------------------------------
// Readings -> the scene events (pure).
//
// One event per transition, through a small memory per player:
//   { playback, source, sourceName, track }  the last values seen (null: none yet)
// - the first reading only arms (nothing fires after a restart), and so does
//   the first reading after the player was offline;
// - `connecting` (playback null) changes nothing: the next answer tells;
// - playback_changed: playing / paused / stopped changed;
// - source_changed: another input, preset or service (a reading without a
//   source changes nothing);
// - track_changed: what plays changed on the same source, while playing;
// - `quiet`: a change caused by a command sent through Gladys arms silently,
//   so a scene bound to an event can never loop through the integration.
// -----------------------------------------------------------------------------

import { SCENE_TRIGGERS } from './constants.js';

const trackOf = (reading) =>
  [reading.title, reading.artist, reading.album]
    .map((part) => String(part ?? '').toLowerCase())
    .join('\n');

/** -> { memory, changes } with changes among 'playback', 'source', 'track'. */
export function transition(memory, reading, { quiet = false } = {}) {
  if (!reading?.online) {
    return { memory: undefined, changes: [] };
  }
  const playback = reading.playback ?? memory?.playback ?? null;
  const source = reading.source?.key ?? memory?.source ?? null;
  const sourceName = reading.source?.name ?? memory?.sourceName ?? '';
  const track = trackOf(reading).trim() ? trackOf(reading) : (memory?.track ?? null);
  const next = { playback, source, sourceName, track };
  if (memory === undefined) {
    return { memory: next, changes: [] };
  }
  const changes = [];
  if (playback !== memory.playback && playback !== null) {
    changes.push('playback');
  }
  const sourceChanged = source !== memory.source && source !== null;
  if (sourceChanged) {
    changes.push('source');
  }
  if (!sourceChanged && playback === 'playing' && track !== null && track !== memory.track) {
    changes.push('track');
  }
  return { memory: next, changes: quiet ? [] : changes };
}

const bound = (text) => String(text ?? '').slice(0, 1000);

/** The scene events of the changes of a reading, flat and bounded. */
export function sceneEvents({ deviceId, name, reading, previous, changes }) {
  const common = {
    player: deviceId,
    player_name: bound(name),
    source: bound(reading.source?.name ?? ''),
    title: bound(reading.title),
    artist: bound(reading.artist),
    album: bound(reading.album),
    summary: bound(reading.summary),
  };
  return changes.map((change) => {
    if (change === 'playback') {
      return {
        key: SCENE_TRIGGERS.PLAYBACK,
        data: { ...common, state: reading.playback, previous_state: previous?.playback ?? null },
      };
    }
    if (change === 'source') {
      return {
        key: SCENE_TRIGGERS.SOURCE,
        data: {
          ...common,
          kind: reading.source?.kind ?? null,
          input_type: reading.source?.inputType || null,
          previous_source: bound(previous?.sourceName ?? ''),
        },
      };
    }
    return { key: SCENE_TRIGGERS.TRACK, data: common };
  });
}
