# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- One device per player that works with BluOS (Bluesound, NAD…), found in
  Discovery over mDNS (`_musc._tcp`, and `_musp._tcp` for the extra zones of
  the multi-zone players) or typed by address: play, pause, previous, next,
  volume 0-100, playback state and notifications like a Sonos in Gladys (the
  Music dashboard box, the "Play a notification" scene action), plus mute,
  source (the inputs and presets of the player), title, artist, album and
  group.
- Live state through the long polling of the BluOS API (`/Status` and
  `/SyncStatus` with etag): no polling clock, the states sent only when they
  change; at most three requests at once per player, never the same one twice
  within a second; offline after two failed polls, retried after 5 s, 10 s,
  20 s… up to 2 minutes, with an "unreachable" badge.
- Announcements: the notifications of Gladys and the "play a sound or a
  stream" scene action play a URL, at the announcement volume if set, then
  put back the volume and resume the play queue (track and second), the
  input or the preset radio that played before.
- Scene triggers "playback changed", "source changed" (filters by kind of
  source and input type) and "new track", silent for the changes made
  through Gladys.
- Scene actions "playback", "play a preset", "change the source", "play a
  sound or a stream", "join a group", "leave its group" and "now playing".
- "Test the players" and "List the sources and presets" buttons.

[Unreleased]: https://github.com/LM1LC3N7/gladys-bluesound/commits/main
