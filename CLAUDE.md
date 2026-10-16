# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its
only runtime dependency (HTTP goes through `node:http`). It drives the
players that work with BluOS (Bluesound, NAD…) through the BluOS Custom
Integration API, plain HTTP + XML on port 11000 of the LAN: one device per
player that behaves like a Sonos in Gladys, live state by long polling,
announcements, three scene triggers, seven scene actions. Local only.
Unofficial: not affiliated with Lenbrook.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` and `audit` before every commit.

## Architecture

```
index.js                SDK bootstrap only
src/handlers.js         every SDK handler -> the app (shared with the tests)
src/app.js              BluesoundApp: discovery, one entry per created player,
                        states and scene events, commands, announcements,
                        scene actions, buttons, connection status
src/player.js           PlayerLink: the /Status and /SyncStatus long-poll loops,
                        backoff, online / offline
src/bluos/client.js     one player: every request, one command at a time,
                        one second between two requests for the same resource
src/bluos/http.js       the only network access (node:http GET, deadline, size
                        cap, no redirect, Connection: close, abortable)
src/bluos/model.js      answers -> values, readings, sources (pure)
src/bluos/xml.js        the small hardened XML parser (pure)
src/bluos/discovery.js  mDNS answers -> addresses, player ids (pure)
src/bluos/errors.js     BluosError and its codes
src/devices.js          the player device, feature keys, external id, states (pure)
src/triggers.js         readings -> the three scene events (pure)
src/announce.js         resume plans and the watch of an announcement (pure)
src/sources.js          what a user types -> an input or a preset (pure)
src/config.js           config_schema normalized, the `hosts` grammar
src/constants.js        timings, limits, manifest keys and trigger values
src/i18n.js             runtime texts (en/fr)
test/fixtures/          recorded answers of real players (homebridge-bluos,
                        Apache-2.0) and answers shaped after the API document
test/helpers/           a fake player (in memory or over loopback HTTP), fake
                        timers; Gladys is the SDK's fake
```

## The protocol, as built

- `GET http://<player>:11000/<Request>`, UTF-8 XML answers, no auth. Long
  polls: `/Status?timeout=100&etag=<last>` and `/SyncStatus?timeout=180&etag=`
  answer on a change or after the timeout; the HTTP deadline is the timeout +
  15 s. After a failure the next poll is a plain read.
- Identity: `/SyncStatus` `mac` (6 fields; the secondary zones of a chassis
  append their port) + the control port -> `player:<12 hex>-<port>`.
- Volume and mute from `/SyncStatus` (a secondary's `/Status` is its
  primary's); muted = `muteVolume` present. `/Volume?level=&tell_slaves=0`,
  `/Volume?mute=1|0`.
- Source: `inputId` -> the Capture list (`/RadioBrowse?service=Capture`),
  else a preset whose `url` is the `streamUrl`, else the `service`. Select
  an input with `/Play?url=<its URL>`, a preset with `/Preset?id=`.
- Next / previous: `/Skip` / `/Back` on the play queue; on a stream (a
  `streamUrl` is present) only the `skip` / `back` action `/Status` offers
  (a path on the player, never another host).
- Groups: `/AddSlave?slave=<ip>&port=` on the primary (the address from the
  member's `/SyncStatus` `id`); `/RemoveSlave` on the primary, or on a
  primary itself to leave.
- Announcements: `/Play?url=`; the end is a stop / pause after the URL
  played; resume by `/Play?seek=&id=` (queue), `/Play?url=` (input),
  `/Preset?id=`.

## Rules

- **Unofficial, and the API policy**: every user-facing surface says
  "unofficial connector, not affiliated with Lenbrook". Never use a
  Bluesound, NAD or BluOS logo; never put their marks in the integration
  name ("… (works with BluOS)" is the acceptable form).
- **Keys are forever**: the manifest keys (`src/constants.js`), the trigger
  values (`PLAYBACK_STATES`, `SOURCE_KINDS`, `INPUT_TYPES`,
  `PLAYBACK_COMMANDS`), the feature keys (`FEATURE` in `src/devices.js`), the
  source option values (`input:<id>`, `preset:<id>`) and the external id
  shape `player:<mac>-<port>` are stored in user scenes and dashboards.
  Never rename them.
- **Be gentle with the players** (API §2): no polling clock, only the two
  long polls per player; one command at a time; never two requests for the
  same resource within a second (`BluosClient.spaced`); the presets are read
  when `prid` changes, the inputs every 30 minutes or when an unknown one
  plays.
- **One event per transition** (`src/triggers.js`): the first reading (and
  the first after offline) only arms; a change caused by a command sent
  through Gladys, or an announcement, arms silently (`quietUntil`).
- **Local only**: the client talks to the addresses of the players (mDNS
  answers on private IPv4 ranges, typed addresses, the primary of a group
  named by the player); an action URL of `/Status` must be a path on the
  same player.
- **Built blind**: no player was at hand. Every request lives in
  `src/bluos/`, so a tester's report fixes one place; `TODO.md` lists what to
  confirm.
- **Read-only rootfs**: write nothing on disk.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag.
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- **Manifest texts** are `{ en, fr }` objects; the catalog description holds
  10 to 100 characters per language; `test/manifest.test.js` ties the
  manifest to the code.
- **User-facing text** is bilingual, `docs/en.md` and `docs/fr.md` kept in
  sync. Comments explain why, in English.
- **Tests never touch the network** (the transport is injected; the loopback
  servers of `test/http.test.js` are the only sockets).

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is
  not a bug in the code.

## Refreshing the fixtures

With a player on the LAN (anonymize the addresses, MAC and names first):

```bash
P=http://192.168.1.20:11000
curl -s "$P/Status"
curl -s "$P/SyncStatus"
curl -s "$P/Presets"
curl -s "$P/RadioBrowse?service=Capture"
```
