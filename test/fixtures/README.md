# Fixtures

## `recorded/`: answers of real players

Copied unchanged from the test fixtures of
[tbaur/homebridge-bluos](https://github.com/tbaur/homebridge-bluos) (Apache-2.0,
`tests/fixtures`, main branch of 2026-10-16): `/SyncStatus` and `/Volume`
answers of a NAD C658, the two zones of a NAD CI S2 (alone, muted, at level
zero, grouped), a Bluesound PULSE FLEX 2i and a PULSE SOUNDBAR+, on BluOS
4.16.6. Their author substituted the addresses, MAC addresses and player
names before committing them (`192.168.4.x`, `90:56:82:0A:00:0n`, "Zone One"...).

What they pin: `/SyncStatus` has no `mute` attribute (a muted player reports
`muteVolume`), a secondary zone appends its port to its `mac`, a follower
names its leader in `<master port>`, and `zoneMaster="true"` inside
`<zoneOptions>` is a stereo-pairing option, not a group.

## The other files: shaped after the documentation

`status-*.xml`, `presets.xml` and `capture.xml` follow the structure of the
examples of Lenbrook's "BluOS Custom Integration API" v1.7 (§2.1 `/Status`,
§4.8 streaming-radio actions, §6.1 `/Presets`, §11.1
`/RadioBrowse?service=Capture`) and of the test data of
[pyblu](https://github.com/LouisChrist/pyblu) (MIT), with their own values
(stations, tracks, ids). No player recorded them: a tester's capture
(`curl http://<player>:11000/Status`) can replace any of them, with the
addresses and MAC anonymized first.
