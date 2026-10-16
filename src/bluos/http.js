// -----------------------------------------------------------------------------
// The only place that talks to the network: one HTTP GET to a player on the
// LAN, with a deadline, a size cap, no redirect and `Connection: close` (a
// fresh connection per request: a long poll never leaves an idle socket
// behind, and a player that rebooted never meets a stale keep-alive one).
// The tests inject another transport (BluosClient `transport` option).
//
// Resolves { status, text } for any HTTP status; throws a BluosError.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { HTTP_TIMEOUT, MAX_BYTES, USER_AGENT } from '../constants.js';
import { BluosError } from './errors.js';

/**
 * GET http://host:port<path>. `signal` cancels it (BluosError 'aborted').
 * The error never quotes the address: the caller names the player.
 */
export function httpGet({
  host,
  port,
  path,
  timeout = HTTP_TIMEOUT,
  maxBytes = MAX_BYTES,
  signal,
  userAgent = USER_AGENT,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let timer;
    const onAbort = () => fail(new BluosError('aborted', 'cancelled'));
    const done = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (!settled) {
        done();
        request?.destroy();
        reject(err);
      }
    };
    const networkError = (err) =>
      new BluosError('network', err?.code ? `network error (${err.code})` : 'network error');

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => fail(new BluosError('timeout', `no answer within ${Math.round(timeout / 1000)} s`)),
      Math.max(1, timeout),
    );
    request = http.request(
      {
        hostname: host,
        port,
        path,
        method: 'GET',
        agent: false,
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/xml, application/xml;q=0.9, */*;q=0.1',
          Connection: 'close',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          fail(new BluosError('redirect', `HTTP ${status} redirect refused`, { status }));
          return;
        }
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            fail(new BluosError('too_large', `answer over ${Math.round(maxBytes / 1024)} KB`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (!settled) {
            done();
            // The players answer UTF-8; a stray byte becomes U+FFFD.
            resolve({ status, text: Buffer.concat(chunks, total).toString('utf8') });
          }
        });
        response.on('error', (err) => fail(networkError(err)));
        // A player cut mid-answer (reboot, Wi-Fi): no 'end', only a close.
        response.on('close', () => {
          if (!response.complete) {
            fail(new BluosError('network', 'connection closed'));
          }
        });
      },
    );
    request.on('error', (err) => fail(networkError(err)));
    request.end();
  });
}
