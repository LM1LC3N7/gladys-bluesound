# TODO — BluOS v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`,
  `npm run audit`, then update README, `docs/en.md`, `docs/fr.md`,
  `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only (before, the store would list an empty integration).
- No forum topic of its own, ever, and no forum post from a module session:
  the claim is in /t/10385 (post #214); the release goes in a recap message
  there, with a link to the repo.

## Status

- [x] **Milestone 1 — core** (2026-10-16): discovery over mDNS (`_musc._tcp`,
      `_musp._tcp`) through the core, typed addresses (port 11000 by default,
      11010-11030 for multi-zone players) and the created players read once;
      one device per player (`player:<mac>-<port>`) with the music features of
      the core Sonos / Google Cast services (play, pause, previous, next,
      volume 0-100, playback state, play_notification) plus mute (toggle),
      source select (inputs of the Capture list + presets), title, artist,
      album, group; live state by `/Status` + `/SyncStatus` long polls, states
      published on change, offline after two failures with a 5 s → 2 min
      backoff and an unreachable badge; at most three requests at once per
      player, one second between two requests for the same resource;
      announcements with volume and resume (queue track + second, input,
      preset); scene triggers `playback_changed`, `source_changed`,
      `track_changed`; scene actions `playback`, `play_preset`,
      `select_source`, `play_url`, `group_add`, `group_remove`,
      `get_now_playing`; buttons "Test the players", "List the sources and
      presets"; source lists re-published when the presets change. Tested
      against fake players (in memory and over loopback HTTP), the recorded
      answers of homebridge-bluos and the SDK fake Gladys. No real player.
- [ ] **Milestone 2 — real players**: a tester's player (see "To check on a
      real player"), captures of `/Status` in every source turned into
      fixtures (anonymized).
- [ ] **Milestone 3 — more**:
  - a dashboard widget: artwork (`image`, fetched with `followRedirects=1`),
    now playing, volume, presets as buttons;
  - the doorbell chime (`/Doorbell?play=1`, API §10), shuffle / repeat, sleep
    timer, group volume (`tell_slaves=1` as an option);
  - battery level of the portable players (`<battery>` of `/SyncStatus`) as
    a battery feature;
  - LSDP (UDP 11430, API §13.1) through `udp-active-broadcast` for networks
    without multicast, once a real player shows it answers a unicast query
    (homebridge-bluos found it unreliable);
  - an mDNS scan when a created player stays offline, to follow a new
    address without a manual Discovery.
- [ ] **Milestone 4 — first release**: cover image, Docker image build check,
      `npx github:GladysAssistant/integration-store .`, Release workflow,
      topic, GHCR package public (the main session publishes, with Louis's OK).

## To check on a real player

- mDNS through the core: does `_musc._tcp` answer with an IPv4 address and
  the port 11000; do the secondary zones of a CI580 answer `_musp._tcp`?
  (Gladys before the "mdns browses every declared entry" change only browses
  the first entry.)
- `/Status` per source: Qobuz/TIDAL queue, TuneIn and Radio Paradise, an
  input (is `inputId` there? is `streamUrl` the Capture URL?), Spotify
  Connect, AirPlay, Bluetooth; the `actions` of the radios.
- Is a preset recognized while it plays (`streamUrl` = the preset `url`, as
  Home Assistant assumes)? Else the source shows the service name.
- `/Play?url=` with the Gladys TTS (https, mp3 from the Gladys Plus
  gateway): does it play, what does `/Status` show (fn, streamUrl, state),
  does it end in `stop`? Does `/Play?seek=&id=` resume the queue on BluOS
  4.x (v1.6 of the API)? Does the queue survive the URL?
- The long polls: 100 s / 180 s held, answered at once on a change, a stale
  etag answered at once (homebridge-bluos measured it on 4.16.6).
- Grouping: `/AddSlave` with the address from `/SyncStatus` `id`;
  `/RemoveSlave` on a primary removing itself; what a secondary's `/Status`
  shows.
- `mute=1` mutes (the parameter table of API §3.1 says the opposite; the
  players and homebridge-bluos agree with §3.4).
- A player in standby: does it answer, and with which state?

## Decisions

- **Not a duplicate** (checked 2026-10-16): the Gladys core master
  (165e0d94, 2026-10-16, after 5.2.1) has `sonos`, `google-cast` and
  `airplay` but nothing for BluOS (`grep -ril 'bluos\|bluesound'` over
  `server/` and `front/src` is empty). The main session checked the store
  index (474 entries), GitHub and the forum the same day: no Bluesound /
  BluOS integration, none claimed. **Music Assistant** (claimed, then
  paused, by someone else) is another thing: a music server with its own
  players and library, which Gladys would drive through that server; this
  module talks to the BluOS players directly, with no server to install,
  and knows their inputs, presets and groups.
- **Own client, no BluOS library** (Louis's reuse rule): npm has `bluos`
  (1.0.0-alpha.1 of January 2023, abandoned, five runtime deps: zod, rxjs,
  lodash.isequal, fast-xml-parser, debug), `@jliuhtonen/nightvision` (LSDP
  only, March 2025, reads its lengths as signed bytes), and plugins, not
  libraries (`homebridge-bluos`, `iobroker.bluesound`, `homebridge-nad-…`).
  The good references are Python and TypeScript apps: pyblu 2.2.0 (MIT,
  active, used by Home Assistant core) and homebridge-bluos 2.0.3
  (Apache-2.0, active, measured on real players). So: a ~250-line client on
  `node:http` (`src/bluos/`), the hardened XML parser of the author's
  Frontier Silicon integration, and those projects read as documentation
  (credited in the README; the recorded answers of homebridge-bluos are
  test fixtures, unchanged, with their licence and origin in
  `test/fixtures/README.md`). The only runtime dependency stays the SDK.
- **Long polling, not a clock**: a `/Status` and a `/SyncStatus` loop per
  player (like Home Assistant), because the `/Status` of a secondary player
  is its primary's: only its own `/SyncStatus` follows its volume. Volume
  and mute always come from `/SyncStatus`; mute is the presence of
  `muteVolume` there (no `mute` attribute in `/SyncStatus`).
- **Features**: the music category exactly as the core Sonos service
  (play, pause, previous, next, volume, playback_state, play_notification),
  so the Music box and "Play a notification" work. The core has no music
  type for mute, source or now playing: mute is `television` /
  `volume-mute` (a toggle button, like the Denon and Frontier Silicon
  integrations), the source a `text` / `select` with string options
  (`input:<id>`, `preset:<id>`; a streaming service shows its name), title
  / artist / album / group read-only `text`. No power feature: the API has
  no standby command.
- **Volume per player** (`tell_slaves=0`): a device is a room; group volume
  is milestone 3.
- **Notifications**: the core relays `play_notification` to external
  integrations without the volume of the scene action (the proxy service of
  `registerProxyService` drops `options`), hence the "Announcement volume"
  option. Resuming is done by the integration (the API has no notification
  request); upstream idea: forward `options.volume` in the
  `DEVICE_SET_VALUE` payload.
- **No loop**: changes caused by a command (and a whole announcement) fire
  no scene event (`quietUntil`).
- **Name**: Lenbrook's API use policy forbids their marks in an integration
  name and gives "[name] (works with BluOS)" as the acceptable form: the
  manifest is "Players (works with BluOS)" (the store allows 30 characters), the brands appear in the
  descriptions only. The repository name (`gladys-bluesound`) was chosen
  before: Louis may want to rename it.
- **Discovery**: mDNS only (plus typed addresses). LSDP is documented as the
  fallback for networks without multicast, but homebridge-bluos found it
  unreliable on real players: milestone 3, if a tester shows it works
  through the core's `udp-active-broadcast` (its answers go to the
  emitter's ephemeral port, which is the only one the core listens on).
- `gladys_version >=5.1.0`: scene declarations and dynamic selects.
- Container limits: 256 MB RAM, 0.5 CPU, read-only rootfs, only `/data`
  writable (unused), bridge network. Gladys rate limits: 300 states/min,
  300 scene events/min (a track change is 3-4 states per player).
- Tests never touch the network: the transport is injected
  (`test/http.test.js` uses loopback servers for the real one).
