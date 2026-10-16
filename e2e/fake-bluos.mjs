// -----------------------------------------------------------------------------
// End-to-end helper: the fake player of the tests behind a real HTTP server on
// port 11000, in its own container. `GET /__set?state=play&name=...` changes
// what it plays (as the BluOS app would), `/__unplug` and `/__plug` take it
// off and back on the network.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { createPlayer } from '../test/helpers/fakePlayer.js';

const player = createPlayer({ host: process.env.PLAYER_HOST ?? 'bluos-fake' });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__set') {
    player.setPlaying(Object.fromEntries(url.searchParams));
    res.end('ok');
    return;
  }
  if (url.pathname === '/__unplug' || url.pathname === '/__plug') {
    if (url.pathname === '/__unplug') player.unplug();
    else player.plugIn();
    res.end('ok');
    return;
  }
  if (url.pathname === '/__requests') {
    res.end(JSON.stringify(player.requests.map((r) => r.raw)));
    return;
  }
  if (player.offline) {
    req.socket.destroy();
    return;
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  player
    .handle(req.url, { signal: controller.signal })
    .then(({ status, text }) => {
      res.writeHead(status, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(text);
    })
    .catch(() => res.destroy());
});

server.listen(11000, '0.0.0.0', () => console.log('fake BluOS player on :11000'));
process.on('SIGTERM', () => process.exit(0));
