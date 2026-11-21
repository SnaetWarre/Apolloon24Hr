import { test } from 'node:test';
import assert from 'node:assert/strict';
import { options, schedule, distribution } from '../scripts/stress/race.mjs';

test('stress flags have safe defaults and reject malformed inputs', () => {
  assert.equal(options([]).ratio, 60);
  assert.equal(options(['--hours', '2', '--seed', 'night']).hours, 2);
  for (const args of [['--hours', '0'], ['--ratio', 'NaN'], ['--other', '1'], ['--out']])
    assert.throws(() => options(args));
});
test('race schedule is reproducible, ordered and seed-dependent', () => {
  const a = schedule(24, 'night');
  assert.deepEqual(a, schedule(24, 'night'));
  assert.notDeepEqual(a, schedule(24, 'different'));
  assert.equal(a.chaos.length, 5);
  assert(a.laps.every((s, i) => s > 0 && (i === 0 || s > a.laps[i - 1])));
  assert.deepEqual(schedule(0, 'empty').laps, []);
});
test('percentiles cover populated and empty series without mutating input', () => {
  const values = [4, 1, 3, 2];
  assert.deepEqual(distribution(values), { count: 4, p50: 2, p95: 4, p99: 4, max: 4 });
  assert.equal(values[0], 4);
  assert.deepEqual(distribution([]), { count: 0, p50: null, p95: null, p99: null, max: null });
});
