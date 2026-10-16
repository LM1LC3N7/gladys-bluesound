# gladys-bluesound

[Gladys Assistant](https://gladysassistant.com) external integration for the
players that work with **BluOS** (Bluesound Node, Powernode, Pulse, NAD
streamers and amplifiers…), on the local network through their BluOS API:
playback, volume, mute, source, presets, now playing, groups and
announcements, followed live, with scene triggers and scene actions. They
behave like Sonos players in Gladys (Music dashboard box, "Play a
notification" scene action). **Unofficial connector, not affiliated with
Lenbrook (Bluesound, NAD) nor with the other brands.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (BluesoundApp)
                 ├─ src/player.js          one live link per player: two long polls
                 ├─ src/bluos/client.js    the requests of one player, paced
                 ├─ src/bluos/http.js      the only network access (node:http)
                 ├─ src/bluos/model.js     answers -> values (pure)
                 ├─ src/bluos/discovery.js mDNS answers, player ids (pure)
                 ├─ src/devices.js         the player device and its states (pure)
                 ├─ src/triggers.js        readings -> scene events (pure)
                 ├─ src/announce.js        what to resume after an announcement (pure)
                 └─ src/sources.js         "optical", "3", "FIP" -> an input or a preset (pure)
```

- **Discovery**: the core browses `_musc._tcp` and `_musp._tcp` over mDNS
  (`network_discovery`); the integration reads each answering player once
  (`/SyncStatus`, `/Presets`, `/RadioBrowse?service=Capture`), plus the
  addresses typed in the configuration and the created players.
- **Live state**: per player, a `/Status` and a `/SyncStatus` long poll
  (etag + `timeout`, 100 s and 180 s as the API document recommends): the
  player answers as soon as something changes. Commands run one at a time
  on their own connection, so a player sees at most three requests at once,
  and never the same resource twice within a second (API §2). Two failed
  polls make a player offline; it is retried after 5 s, 10 s, 20 s… up to
  2 minutes.
- **Announcements** (`play_notification`, `play_url`): the player plays the
  URL; the live `/Status` tells when it ends; the volume and what played
  before come back (play queue at its second, input, preset radio).
- **Triggers** come from two consecutive readings; the first one only arms,
  and the changes caused by Gladys itself fire nothing.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npx github:GladysAssistant/integration-store .  # store admission checks
```

The only runtime dependency is the Gladys SDK: no maintained Node.js BluOS
client exists (see [TODO.md](TODO.md), "Decisions"), so the client is a small
one on `node:http`.

## Credits

- Lenbrook's **BluOS Custom Integration API** v1.7 (bluos.io), the protocol
  reference. Not redistributed here.
- [pyblu](https://github.com/LouisChrist/pyblu) (MIT), the library of the
  Home Assistant integration, and the
  [Home Assistant bluesound integration](https://www.home-assistant.io/integrations/bluesound/):
  how they read the answers, long-poll, pick the sources and group the
  players. Read as documentation, no code copied.
- [homebridge-bluos](https://github.com/tbaur/homebridge-bluos) (Apache-2.0):
  its notes on real firmware (mute, multi-zone identity) and its recorded,
  pseudonymised answers of real players, used unchanged as test fixtures
  (`test/fixtures/recorded/`, see its README).

This first version was built without a player: see [TODO.md](TODO.md) for
what a real one must confirm.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
