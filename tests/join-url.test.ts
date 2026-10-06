import assert from 'node:assert/strict';
import test from 'node:test';
import { joinUrl } from '../server/peers.ts';

test('joining an address without a port goes to the app port, not port 80', () => {
  assert.equal(joinUrl('192.168.1.20', 5173), 'http://192.168.1.20:5173');
  assert.equal(joinUrl(' http://192.168.1.20/ ', 5173), 'http://192.168.1.20:5173');
  assert.equal(joinUrl('apolloon-tijd', 5173), 'http://apolloon-tijd:5173');
  assert.equal(joinUrl('[fe80::1]', 5173), 'http://[fe80::1]:5173');
});

test('joining keeps a port the operator typed', () => {
  assert.equal(joinUrl('192.168.1.20:5173', 4000), 'http://192.168.1.20:5173');
  assert.equal(joinUrl('http://apolloon-tijd:4000/beheer', 5173), 'http://apolloon-tijd:4000');
  assert.equal(joinUrl('http://192.168.1.20:80', 5173), 'http://192.168.1.20');
});

test('joining refuses what is not a laptop address', () => {
  assert.equal(joinUrl('', 5173), '');
  assert.equal(joinUrl('ftp://192.168.1.20', 5173), '');
});
