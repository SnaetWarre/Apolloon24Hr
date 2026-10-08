import assert from 'node:assert/strict';
import test from 'node:test';
import { temporaryDataPath } from './temporary-data.ts';

process.env.DATA_PATH = temporaryDataPath('link-direction');
process.env.NODE_ENV = 'test';

const { linkDirection } = await import('../server/cluster.ts');

const fresh = { clusterId: 'b', runners: 0, changed: false, laptops: 1 };
const prepared = { clusterId: 'a', runners: 0, changed: true, laptops: 1 };

test('with as many runners, the laptop someone prepared keeps its data, whatever the group ids', () => {
  assert.equal(linkDirection(prepared, fresh), 'invite');
  assert.equal(linkDirection(fresh, prepared), 'join');
  assert.equal(linkDirection({ ...prepared, clusterId: 'z' }, fresh), 'invite');
  assert.equal(linkDirection(fresh, { ...prepared, clusterId: 'z' }), 'join');
});

test('a prepared laptop keeps its data over a larger group nobody changed', () => {
  assert.equal(linkDirection(prepared, { ...fresh, laptops: 2 }), 'invite');
  assert.equal(linkDirection({ ...fresh, laptops: 2 }, prepared), 'join');
});

test('runners still come first', () => {
  const withRunners = { ...fresh, runners: 40, changed: true };
  assert.equal(linkDirection(prepared, withRunners), 'join');
  assert.equal(linkDirection(withRunners, prepared), 'invite');
});

test('two laptops alike fall back to group size, then group id, the same way on both sides', () => {
  assert.equal(linkDirection(prepared, { ...prepared, clusterId: 'b', laptops: 2 }), 'join');
  assert.equal(linkDirection({ ...fresh, clusterId: 'a' }, fresh), 'invite');
  assert.equal(linkDirection(fresh, { ...fresh, clusterId: 'a' }), 'join');
});
