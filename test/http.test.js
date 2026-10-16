// -----------------------------------------------------------------------------
// The real transport (node:http) against servers on 127.0.0.1: the fake
// player behind HTTP, and small servers that misbehave.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BluosClient } from '../src/bluos/client.js';
import { httpGet } from '../src/bluos/http.js';
import { createPlayer, serve, settle } from './helpers/fakePlayer.js';

async function server(handler) {
  const s = http.createServer(handler);
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  return {
    port: s.address().port,
    close: () =>
      new Promise((resolve) => {
        s.closeAllConnections();
        s.close(() => resolve());
      }),
  };
}

test('the client over real HTTP: reads, a long poll answered on change', async () => {
  const player = createPlayer();
  const served = await serve(player);
  try {
    const client = new BluosClient({ host: '127.0.0.1', port: served.port, sleep: async () => {} });
    const sync = await client.readSyncStatus();
    assert.equal(sync.name, 'Amplifier');
    const status = await client.status();
    const held = client.status({ etag: status.etag, timeout: 100 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(player.held('status'), 1);
    player.setPlaying({ state: 'play', name: 'Freddie Freeloader' });
    assert.equal((await held).name, 'Freddie Freeloader');
    // Cancelled while held: the server side sees the connection go.
    const again = client.status({ etag: String(player.statusEtag), timeout: 100 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.close();
    await assert.rejects(again, (err) => err.code === 'aborted');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(player.held('status'), 0);
    const headers = player.requests.length;
    assert.ok(headers >= 4);
  } finally {
    await served.close();
  }
});

test('headers sent, any status resolved, redirects refused', async () => {
  let seen;
  const s = await server((req, res) => {
    seen = req.headers;
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'http://example.com/' }).end();
    } else {
      res.writeHead(404).end('<error/>');
    }
  });
  try {
    const answer = await httpGet({ host: '127.0.0.1', port: s.port, path: '/Nope' });
    assert.deepEqual(answer, { status: 404, text: '<error/>' });
    assert.match(seen['user-agent'], /^gladys-bluesound/);
    assert.equal(seen.connection, 'close');
    await assert.rejects(
      httpGet({ host: '127.0.0.1', port: s.port, path: '/redirect' }),
      (err) => err.code === 'redirect',
    );
  } finally {
    await s.close();
  }
});

test('size cap, deadline, refused connection', async () => {
  const s = await server((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200);
      res.end('x'.repeat(2048));
    }
    // '/slow': never answers
  });
  try {
    await assert.rejects(
      httpGet({ host: '127.0.0.1', port: s.port, path: '/big', maxBytes: 1024 }),
      (err) => err.code === 'too_large',
    );
    await assert.rejects(
      httpGet({ host: '127.0.0.1', port: s.port, path: '/slow', timeout: 100 }),
      (err) => err.code === 'timeout' && err.unreachable,
    );
  } finally {
    await s.close();
  }
  await settle();
  await assert.rejects(
    httpGet({ host: '127.0.0.1', port: s.port, path: '/Status', timeout: 2000 }),
    (err) =>
      err.code === 'network' && /ECONNREFUSED/.test(err.message) && !/127\.0/.test(err.message),
  );
});

test('an aborted signal cancels before and during the request', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    httpGet({ host: '127.0.0.1', port: 9, path: '/', signal: before.signal }),
    (err) => err.code === 'aborted',
  );
  const s = await server(() => {});
  try {
    const during = new AbortController();
    const pending = httpGet({ host: '127.0.0.1', port: s.port, path: '/', signal: during.signal });
    setTimeout(() => during.abort(), 20);
    await assert.rejects(pending, (err) => err.code === 'aborted');
  } finally {
    await s.close();
  }
});
