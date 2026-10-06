import assert from 'node:assert/strict';
import test from 'node:test';
import { toggleRunnerLabel } from '../src/lib/labels.ts';
import { foldSearchText, runnerMatchesSearch } from '../src/lib/runners.ts';
import type { Label } from '../src/types.ts';
import { temporaryDataPath } from './temporary-data.ts';

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

test('runner search ignores accents both ways', () => {
  const runner = (name: string) => ({ runnerNumber: '12', name, labels: [] });
  assert.equal(runnerMatchesSearch(runner('Zoë Peeters'), 'zoe'), true);
  assert.equal(runnerMatchesSearch(runner('Zoë Peeters'), 'zoë'), true);
  assert.equal(runnerMatchesSearch(runner('Céline Maes'), 'celine'), true);
  assert.equal(runnerMatchesSearch(runner('Anaïs Claes'), 'ANAIS'), true);
  assert.equal(runnerMatchesSearch(runner('Helene Wouters'), 'hélène'), true);
  assert.equal(runnerMatchesSearch(runner('Zoë Peeters'), 'celine'), false);
});

test('search text folds case and accents', () => {
  assert.equal(foldSearchText('Hélène ANAÏS Zoë'), 'helene anais zoe');
});

test('a label deleted on another laptop is skipped, not recreated under its id', async () => {
  process.env.DATA_PATH = temporaryDataPath('runner-labels');
  process.env.NODE_ENV = 'test';
  const db = await import('../server/db.ts');
  await db.initDb();
  try {
    const club = db.recordWrite('label', () => db.createLabel({ name: 'Atletiekclub Gent' }));
    const hilok = db.recordWrite('label', () => db.createLabel({ name: 'HILOK-vrienden' }));
    const anna = db.recordWrite('runner', () =>
      db.insertRunner({ name: 'Anna', runnerNumber: '1', labels: [club.id, hilok.id] })
    );
    db.recordWrite('label', () => db.deleteLabel(club.id));
    const labelsBefore = db.getLabels().length;

    db.recordWrite('runner', () => db.updateRunner(anna.id, { labels: [club.id, hilok.id] }));
    const bert = db.recordWrite('runner', () =>
      db.insertRunner({ name: 'Bert', runnerNumber: '2', labels: [club.id, hilok.id] })
    );

    assert.equal(db.getLabels().length, labelsBefore);
    assert.deepEqual(
      db.getRunnerById(anna.id)?.labels.map((label) => label.id),
      [hilok.id]
    );
    assert.deepEqual(
      db.getRunnerById(bert.id)?.labels.map((label) => label.id),
      [hilok.id]
    );

    const carla = db.recordWrite('runner', () =>
      db.insertRunner({ name: 'Carla', runnerNumber: '3', labels: ['Nieuwe club'] })
    );
    assert.deepEqual(
      db.getRunnerById(carla.id)?.labels.map((label) => label.name),
      ['Nieuwe club']
    );
  } finally {
    db.closeDb();
  }
});
