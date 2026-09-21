import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isApipaAddress,
  isLoopbackAddress,
  isPrivateLanAddress,
  parseIpv4,
  prefixLengthToMask,
  sameSubnet,
  validateStaticRequest,
} from '../server/net-setup.ts';

test('only real loopback callers may change host networking', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.211'), false);
  assert.equal(isLoopbackAddress('10.0.0.5'), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(''), false);
});

test('IPv4 parsing rejects hostnames and out-of-range octets', () => {
  assert.deepEqual(parseIpv4('192.168.1.211'), [192, 168, 1, 211]);
  assert.deepEqual(parseIpv4(' 10.0.0.5 '), [10, 0, 0, 5]);
  assert.deepEqual(parseIpv4('10.0.0.5'), [10, 0, 0, 5]);
  assert.equal(parseIpv4('192.168.1.256'), null);
  assert.equal(parseIpv4('192.168.1'), null);
  assert.equal(parseIpv4('telsysteem1.local'), null);
  assert.equal(parseIpv4('192.168.1.1; rm -rf /'), null);
  assert.equal(parseIpv4(''), null);
  assert.equal(parseIpv4(undefined), null);
});

test('APIPA and private ranges are classified correctly', () => {
  assert.equal(isApipaAddress('169.254.10.20'), true);
  assert.equal(isApipaAddress('192.168.1.211'), false);
  assert.equal(isPrivateLanAddress('192.168.1.211'), true);
  assert.equal(isPrivateLanAddress('10.3.0.9'), true);
  assert.equal(isPrivateLanAddress('172.20.4.4'), true);
  assert.equal(isPrivateLanAddress('8.8.8.8'), false);
  assert.equal(isPrivateLanAddress('169.254.10.20'), false);
});

test('same-subnet check catches third-octet mismatches', () => {
  assert.equal(sameSubnet('192.168.1.211', '192.168.1.1'), true);
  assert.equal(sameSubnet('192.168.1.211', '192.168.10.1'), false);
  assert.equal(sameSubnet('192.168.1.211', 'not-an-ip'), false);
});

test('prefix length helper only allows sane masks', () => {
  assert.equal(prefixLengthToMask(24), '255.255.255.0');
  assert.equal(prefixLengthToMask(16), '255.255.0.0');
  assert.equal(prefixLengthToMask(12), '255.240.0.0');
  assert.equal(prefixLengthToMask(33), null);
  assert.equal(prefixLengthToMask(7), null);
});

test('static-IP requests accept the happy path', () => {
  const result = validateStaticRequest({ ip: '192.168.1.211', prefixLength: 24, gateway: '192.168.1.1' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ip, '192.168.1.211');
    assert.equal(result.gateway, '192.168.1.1');
  }
  const isolated = validateStaticRequest({ ip: '192.168.10.11', gateway: '' });
  assert.equal(isolated.ok, true);
});

test('static-IP requests refuse APIPA, broadcast and cross-subnet gateways', () => {
  assert.equal(validateStaticRequest({ ip: '169.254.10.20' }).ok, false);
  assert.equal(validateStaticRequest({ ip: '192.168.1.0' }).ok, false);
  assert.equal(validateStaticRequest({ ip: '192.168.1.255' }).ok, false);
  assert.equal(validateStaticRequest({ ip: 'telsysteem1' }).ok, false);
  assert.equal(validateStaticRequest({ ip: '192.168.1.211', prefixLength: 12 }).ok, false);
  const crossGateway = validateStaticRequest({ ip: '192.168.1.211', gateway: '192.168.10.1' });
  assert.equal(crossGateway.ok, false);
});
