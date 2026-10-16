// -----------------------------------------------------------------------------
// mDNS answers, player ids and the typed addresses.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMdnsTxt } from '@gladysassistant/integration-sdk';
import {
  instanceName,
  isLanIPv4,
  mdnsCandidates,
  parseEndpoint,
  playerIdOf,
} from '../src/bluos/discovery.js';
import { normalizeConfig, parseHosts } from '../src/config.js';

// The raw shape the core relays (networkDiscovery.scanMdns.js); TXT keys as
// homebridge-bluos describes them (model, version, mac, zs).
const answer = (name, addresses, port, txt = []) => ({
  name: `${name}._musc._tcp.local`,
  host: `${name.replace(/\s/g, '-')}.local`,
  addresses,
  port,
  txt,
});

test('mDNS answers -> one candidate per LAN address and port', () => {
  const results = [
    answer('Salon', ['fe80::1', '192.168.1.20'], 11000, ['model=N130', 'mac=90:56:82:11:22:33']),
    answer('Salon', ['192.168.1.20'], 11000),
    { ...answer('CI580 zone 2', ['192.168.1.30'], 11010), name: 'CI580 zone 2._musp._tcp.local' },
    answer('Public', ['8.8.8.8'], 11000),
    answer('Loopback', ['127.0.0.1'], 11000),
    answer('No address', [], 11000),
    answer('Bad port', ['10.0.0.5'], 0),
  ];
  assert.deepEqual(mdnsCandidates(results), [
    { host: '192.168.1.20', port: 11000, name: 'Salon' },
    { host: '192.168.1.30', port: 11010, name: 'CI580 zone 2' },
    { host: '10.0.0.5', port: 11000, name: 'Bad port' },
  ]);
  assert.deepEqual(mdnsCandidates(undefined), []);
  assert.equal(parseMdnsTxt(results[0].txt).model, 'N130');
});

test('LAN addresses', () => {
  for (const ok of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.3.4']) {
    assert.ok(isLanIPv4(ok), ok);
  }
  for (const no of ['172.32.0.1', '8.8.8.8', '127.0.0.1', '192.168.1', '192.168.1.300', 'host']) {
    assert.ok(!isLanIPv4(no), no);
  }
  assert.equal(instanceName('Living Room._musc._tcp.local'), 'Living Room');
  assert.equal(instanceName('Plain'), 'Plain');
});

test('the player id: MAC and port, the zone suffix dropped', () => {
  assert.equal(playerIdOf({ mac: '90:56:82:0A:00:02', port: 11000 }), '9056820a0002-11000');
  // A secondary zone: same chassis MAC, its port as a seventh field.
  assert.equal(playerIdOf({ mac: '90:56:82:0A:00:02:11010', port: 11010 }), '9056820a0002-11010');
  assert.equal(playerIdOf({ mac: '9:56:82:a:0:2', port: 11000 }), '0956820a0002-11000');
  assert.equal(playerIdOf({ mac: '', host: '192.168.1.20', port: 11000 }), 'ip-192-168-1-20-11000');
  assert.equal(playerIdOf({ mac: '00:00:00:00:00:00', host: 'salon.lan' }), 'ip-salon-lan-11000');
  assert.equal(playerIdOf({ mac: 'ABC-123' }), 'abc123-11000');
});

test('endpoints of the answers', () => {
  assert.deepEqual(parseEndpoint('192.168.1.20:11000'), { host: '192.168.1.20', port: 11000 });
  assert.equal(parseEndpoint('192.168.1.20'), undefined);
  assert.equal(parseEndpoint('x:99999'), undefined);
});

test('the typed addresses: host, :port, separators, refusals by position', () => {
  const { hosts, invalid } = parseHosts(
    '192.168.1.20, salon.lan:11010;http://192.168.1.21\n192.168.1.20 ftp://x http://u:p@h /path h/path [fd00::20]:11000 192.168.1.22:80',
  );
  assert.deepEqual(hosts, [
    { host: '192.168.1.20', port: 11000 },
    { host: 'salon.lan', port: 11010 },
    { host: '192.168.1.21', port: 11000 },
    { host: 'fd00::20', port: 11000 },
    { host: '192.168.1.22', port: 80 },
  ]);
  assert.deepEqual(invalid, [5, 6, 7, 8]);
});

test('the configuration, with its defaults and bounds', () => {
  assert.deepEqual(normalizeConfig(), { hosts: [], invalidHosts: [], notificationVolume: 0 });
  assert.equal(normalizeConfig({ notification_volume: 140 }).notificationVolume, 100);
  assert.equal(normalizeConfig({ notification_volume: '35' }).notificationVolume, 35);
  assert.equal(normalizeConfig({ notification_volume: '' }).notificationVolume, 0);
  assert.equal(normalizeConfig({ notification_volume: 'loud' }).notificationVolume, 0);
});
