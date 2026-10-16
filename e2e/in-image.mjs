// -----------------------------------------------------------------------------
// End-to-end check run INSIDE the integration image (read-only rootfs,
// 256 MB, 0.5 CPU): the real app, its real HTTP transport and long polls,
// against the fake player container, with the SDK's fake Gladys standing in
// for Gladys. Prints one line per check; exits 1 on the first failure.
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BluesoundApp } from '/app/src/app.js';
import { registerHandlers } from '/app/src/handlers.js';

const HOST = process.env.PLAYER_HOST ?? 'bluos-fake';
const control = (path) => fetch(`http://${HOST}:11000${path}`).then((r) => r.text());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error(`timed out: ${what}`);
}
const ok = (line) => console.log(`ok - ${line}`);

const gladys = createFakeGladys({ selector: 'bluos', config: { hosts: `${HOST}:11000` } });
const app = new BluesoundApp({
  gladys,
  logger: { debug() {}, info() {}, warn: console.warn, error: console.error },
});
registerHandlers(gladys, app, console);
await gladys.connect();

const [device] = gladys.fake.discoveredDevices;
assert.equal(device?.name, 'Amplifier');
ok(`discovery over HTTP: ${device.external_id}, ${device.features.length} features`);

await gladys.fake.deviceCreated(device);
const f = (key) => `${device.external_id}:${key}`;
await until(() => gladys.fake.lastState(f('title')) === 'So What', 'first states');
ok(
  `live states: ${gladys.fake.lastState(f('title'))}, volume ${gladys.fake.lastState(f('volume'))}`,
);

const t0 = Date.now();
await control('/__set?state=play&name=Freddie%20Freeloader&title1=Freddie%20Freeloader');
await until(() => gladys.fake.lastState(f('title')) === 'Freddie Freeloader', 'long poll answer');
ok(`a change reaches Gladys through the held long poll in ${Date.now() - t0} ms`);
assert.equal(gladys.fake.lastState(f('playback_state')), 1);
assert.deepEqual(
  gladys.fake.sceneEvents.map((e) => e.key),
  ['playback_changed', 'track_changed'],
);
ok('scene events: playback_changed, track_changed');

let ack = await gladys.fake.setValue(device, { external_id: f('volume') }, 25);
assert.equal(ack.success, true);
await until(() => gladys.fake.lastState(f('volume')) === 25, 'volume');
ack = await gladys.fake.sceneAction('select_source', {
  player: device.external_id,
  source: 'optical',
});
assert.deepEqual(ack.data.outputs, { source: 'Optical Input', kind: 'input' });
await until(() => gladys.fake.lastState(f('source')) === 'input:input1', 'source');
ok('commands: volume 25, source "optical" -> Optical Input');

ack = await gladys.fake.setValue(
  device,
  { external_id: f('play_notification') },
  'http://example.invalid/tts.mp3',
);
assert.equal(ack.success, true);
await wait(300);
await control('/__set?state=stop');
await until(
  async () =>
    JSON.parse(await control('/__requests')).includes(
      '/Play?url=Capture%3Ahw%3Aimxspdif%2C0%2F1%2F25%2F2%3Fid%3Dinput1',
    ),
  'resume of the input',
);
ok('notification played, then the optical input selected again');

await control('/__unplug');
await until(
  () => gladys.fake.transports.at(-1)?.transport === 'unreachable',
  'offline after two failed polls',
  20_000,
);
ok(`unplugged: offline, playback state ${gladys.fake.lastState(f('playback_state'))}`);
await control('/__plug');
await until(() => gladys.fake.transports.at(-1)?.transport === 'local', 'back online', 30_000);
ok('plugged back: online again after the backoff');

const requests = JSON.parse(await control('/__requests'));
const polls = requests.filter((r) => r.startsWith('/Status?timeout=100&etag=')).length;
ok(`${requests.length} requests in total, ${polls} /Status long polls`);
console.log(`rss MB: ${Math.round(process.memoryUsage().rss / 1048576)}`);

await app.stop();
await gladys.disconnect();
ok('stopped cleanly');
