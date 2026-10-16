// -----------------------------------------------------------------------------
// Announcements: play a URL (the TTS of Gladys, a chime...) then put back
// what played before, as the Sonos service of the core does (pure).
//
// The Custom Integration API has no "notification" request: /Play?url=
// replaces what plays. So the integration remembers what played and, once
// the announcement ends, plays it again, where the API allows it:
// - the play queue: /Play?id=<track>&seek=<seconds> (API §4.1, BluOS 4.0+);
// - an input: /Play?url=<its Capture URL> (API §11.1);
// - a preset (a radio station of the presets): /Preset?id= (API §6.2).
// Anything else (a station outside the presets, Spotify Connect, AirPlay)
// cannot be resumed through the API: the player stays stopped.
//
// The end is read from the live /Status: the announcement started once the
// player plays something else than before; it ended once it stops or
// pauses; if the user plays something else meanwhile, nothing is resumed.
// -----------------------------------------------------------------------------

import { playbackOf, sourceOf } from './bluos/model.js';

/** What plays, as far as the announcement watch needs to tell two contents apart. */
export function contentOf(status) {
  return JSON.stringify([
    status?.fn ?? '',
    status?.streamUrl ?? '',
    status?.title1 ?? '',
    status?.title2 ?? '',
    status?.service ?? '',
  ]);
}

/**
 * How to play again what `status` plays, or null (nothing plays, or the API
 * cannot resume it). `elapsedMs`: the time since the status was read (the
 * player counts the seconds of a track, not the document).
 */
export function resumePlanOf(status, { presets = [], inputs = [] } = {}, { elapsedMs = 0 } = {}) {
  if (playbackOf(status?.state) !== 'playing') {
    return null;
  }
  const source = sourceOf(status, { presets, inputs });
  if (source?.kind === 'input') {
    const input = inputs.find((i) => `input:${i.id}` === source.key);
    return input ? { kind: 'input', url: input.url, name: input.name } : null;
  }
  if (source?.kind === 'preset') {
    return { kind: 'preset', id: Number(source.key.slice('preset:'.length)), name: source.name };
  }
  if (status.streamUrl === undefined && Number.isInteger(status.song)) {
    const seek = Math.max(0, Math.floor((status.secs ?? 0) + elapsedMs / 1000));
    return { kind: 'queue', id: status.song, seek };
  }
  return null;
}

/**
 * One step of the watch of an announcement, at each new /Status.
 * announce: { before, started, startedAt, playing } (playing: the content of
 * the announcement once seen). -> { announce, done } where done is null
 * (still watching), 'ended', 'replaced' or 'not_started'.
 */
export function watchStep(announce, status, now, { startTimeout, maxDuration }) {
  const playback = playbackOf(status?.state);
  const content = contentOf(status);
  if (!announce.started) {
    if (playback === 'playing' && content !== announce.before) {
      return { announce: { ...announce, started: true, playing: content }, done: null };
    }
    if (now - announce.startedAt > startTimeout) {
      return { announce, done: 'not_started' };
    }
    return { announce, done: null };
  }
  if (playback === 'paused' || playback === 'stopped') {
    return { announce, done: 'ended' };
  }
  if (playback === 'playing' && content !== announce.playing) {
    // Track lines of a stream can change; another source cannot be ours.
    const before = JSON.parse(announce.playing);
    const after = JSON.parse(content);
    if (before[0] !== after[0] || before[1] !== after[1] || before[4] !== after[4]) {
      return { announce, done: 'replaced' };
    }
  }
  if (now - announce.startedAt > maxDuration) {
    return { announce, done: 'replaced' };
  }
  return { announce, done: null };
}
