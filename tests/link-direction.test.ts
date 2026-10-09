import assert from 'node:assert/strict';
import test from 'node:test';
import { temporaryDataPath } from './temporary-data.ts';

process.env.DATA_PATH = temporaryDataPath('link-direction');
process.env.NODE_ENV = 'test';

const { linkDirection } = await import('../server/cluster.ts');

const fresh = { clusterId: 'b', raceStarted: false, runners: 0, changed: false, laptops: 1 };
const prepared = { clusterId: 'a', raceStarted: false, runners: 0, changed: true, laptops: 1 };

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

test('without a race on either side, runners come first', () => {
  const withRunners = { ...fresh, runners: 40, changed: true };
  assert.equal(linkDirection(prepared, withRunners), 'join');
  assert.equal(linkDirection(withRunners, prepared), 'invite');
});

test('two laptops alike fall back to group size, then group id, the same way on both sides', () => {
  assert.equal(linkDirection(prepared, { ...prepared, clusterId: 'b', laptops: 2 }), 'join');
  assert.equal(linkDirection({ ...fresh, clusterId: 'a' }, fresh), 'invite');
  assert.equal(linkDirection(fresh, { ...fresh, clusterId: 'a' }), 'join');
});

test('a group where the race started keeps its data against a spare with more runners', () => {
  const race = { ...prepared, clusterId: 'z', raceStarted: true, runners: 60, laptops: 3 };
  const spare = { ...prepared, runners: 61 };
  assert.equal(linkDirection(spare, race), 'join');
  assert.equal(linkDirection(race, spare), 'there');
  assert.equal(linkDirection({ ...spare, laptops: 1 }, { ...race, laptops: 1 }), 'join');
});

test('the race beats runner count the other way too', () => {
  const race = { ...prepared, raceStarted: true, runners: 61 };
  const spare = { ...prepared, clusterId: 'z', runners: 60 };
  assert.equal(linkDirection(spare, race), 'join');
  assert.equal(linkDirection(race, spare), 'there');
});

test('with the race started on both sides, runners decide as before', () => {
  const more = { ...prepared, raceStarted: true, runners: 61 };
  const fewer = { ...prepared, clusterId: 'z', raceStarted: true, runners: 60, laptops: 3 };
  assert.equal(linkDirection(fewer, more), 'join');
  assert.equal(linkDirection(more, fewer), 'there');
  assert.equal(linkDirection({ ...more, runners: 60 }, fewer), 'join');
  assert.equal(linkDirection(fewer, { ...more, runners: 60 }), 'there');
});
