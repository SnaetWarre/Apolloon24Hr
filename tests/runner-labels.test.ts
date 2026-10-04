import assert from 'node:assert/strict';
import test from 'node:test';
import { toggleRunnerLabel } from '../src/lib/labels.ts';
import { runnerMatchesSearch } from '../src/lib/runners.ts';
import type { Label } from '../src/types.ts';

const label = (id: string, kind: string, name = id): Label => ({
  id,
  name,
  color: '#000000',
  icon: '',
  kind,
  imageUrl: null,
  targetLaps: null,
  sortOrder: null,
});
const labels = [
  label('blue', 'speedteam'),
  label('white', 'speedteam'),
  label('night', 'temporary_team'),
  label('hilok', 'zustervereniging'),
  label('first-year', 'andere'),
  label('women', 'andere'),
];

test('a runner runs for one speedteam but combines other labels', () => {
  assert.deepEqual(toggleRunnerLabel(['blue'], 'white', labels), ['white']);
  assert.deepEqual(toggleRunnerLabel(['first-year'], 'women', labels), ['first-year', 'women']);
  assert.deepEqual(toggleRunnerLabel(['blue', 'hilok'], 'first-year', labels), ['blue', 'hilok', 'first-year']);
  assert.deepEqual(toggleRunnerLabel(['blue', 'women'], 'women', labels), ['blue']);
});

test('night teams cannot be picked by hand', () => {
  assert.deepEqual(toggleRunnerLabel(['blue'], 'night', labels), ['blue']);
});

test('runner search matches number, name, and labels together', () => {
  const runner = { runnerNumber: '149', name: 'Bram Lenaerts', labels: [label('hilok', 'zustervereniging', 'HILOK')] };
  assert.equal(runnerMatchesSearch(runner, ''), true);
  assert.equal(runnerMatchesSearch(runner, ' 149 BRAM '), true);
  assert.equal(runnerMatchesSearch(runner, 'hilok'), true);
  assert.equal(runnerMatchesSearch(runner, 'lenaerts'), true);
  assert.equal(runnerMatchesSearch(runner, 'kobe'), false);
});
