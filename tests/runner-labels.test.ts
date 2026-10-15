import assert from 'node:assert/strict';
import test from 'node:test';
import { runnersToAdd, suggestedMembers, toggleRunnerLabel } from '../src/lib/labels.ts';
import { adminStatusText, foldSearchText, runnerMatchesSearch } from '../src/lib/runners.ts';
import type { Label, Runner, RunnerRegistration } from '../src/types.ts';
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

const runner = (id: string, runnerNumber: string, name: string, own: Label[] = []) =>
  ({ id, runnerNumber, name, labels: own }) as Runner;

test('the add box puts the exact number first and leaves out who is already in the label', () => {
  const runners = [
    runner('a', '12', 'Bram Lenaerts'),
    runner('b', '112', 'Anna Peeters'),
    runner('c', '3', 'Jan Twaalf', [labels[0]]),
    runner('d', '7', 'Lotte Bram'),
  ];
  assert.deepEqual(
    runnersToAdd(runners, 'blue', '12').map((item) => item.id),
    ['a', 'b']
  );
  assert.deepEqual(
    runnersToAdd(runners, 'blue', 'bram').map((item) => item.id),
    ['d', 'a']
  );
  assert.deepEqual(
    runnersToAdd(runners, 'blue', 'twaalf').map((item) => item.id),
    []
  );
  assert.deepEqual(runnersToAdd(runners, 'blue', '  '), []);
});

test('runners whose study phase fits 1ste jaar or Anciens are suggested', () => {
  const firstYear = label('first-year', 'andere', '1ste jaar');
  const anciens = label('anciens', 'andere', 'Anciens');
  const runners = [
    runner('a', '1', 'Al Ticked', [firstYear]),
    runner('b', '2', 'Bo Forgot'),
    runner('c', '3', 'Cas Hasselt'),
    runner('d', '4', 'Dee Second'),
    runner('e', '5', 'Eli Graduated'),
  ];
  const phases: Record<string, string> = {
    a: '1ste bach',
    b: '1ste bach',
    c: '1e bach (hasselt)',
    d: '2de bach',
    e: 'net afgestudeerd',
  };
  const registrations = Object.fromEntries(
    Object.entries(phases).map(([id, studyPhase]) => [id, { studyPhase } as RunnerRegistration])
  );
  assert.deepEqual(
    suggestedMembers(runners, firstYear, registrations).map((item) => item.id),
    ['b', 'c']
  );
  assert.deepEqual(
    suggestedMembers(runners, anciens, registrations).map((item) => item.id),
    ['e']
  );
  assert.deepEqual(suggestedMembers(runners, label('hilok', 'zustervereniging', 'HILOK'), registrations), []);
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

test('Beheer › Lopers marks a runner hidden from the queue as verborgen', () => {
  assert.equal(adminStatusText({ status: 'ran', hiddenFromQueue: true }), 'Heeft gelopen · verborgen');
  assert.equal(adminStatusText({ status: 'ran', hiddenFromQueue: false }), 'Heeft gelopen');
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

test('Beheer › Labels adds a runner to a label and takes them out again', async () => {
  process.env.DATA_PATH = temporaryDataPath('runner-labels');
  process.env.NODE_ENV = 'test';
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  await db.initDb();
  try {
    const caller = appRouter.createCaller({});
    const byName = new Map(db.getLabels().map((item) => [item.name, item.id]));
    const white = byName.get('Speedteam White')!;
    const blue = byName.get('Speedteam Blue')!;
    const hilok = byName.get('HILOK')!;
    const anna = db.recordWrite('runner', () => db.insertRunner({ name: 'Anna', runnerNumber: '1', labels: [white] }));
    const names = () => db.getRunnerById(anna.id)?.labels.map((item) => item.name);

    await caller.labels.addRunner({ labelId: hilok, runnerId: anna.id });
    assert.deepEqual(names(), ['Speedteam White', 'HILOK']);
    // One speedteam per runner: joining Blue leaves White.
    await caller.labels.addRunner({ labelId: blue, runnerId: anna.id });
    assert.deepEqual(names(), ['Speedteam Blue', 'HILOK']);
    await caller.labels.addRunner({ labelId: blue, runnerId: anna.id });
    assert.deepEqual(names(), ['Speedteam Blue', 'HILOK']);

    await caller.labels.removeRunner({ labelId: blue, runnerId: anna.id });
    assert.deepEqual(names(), ['HILOK']);
    await assert.rejects(caller.labels.addRunner({ labelId: 'weg', runnerId: anna.id }), /niet gevonden/);

    const activity = db.getActivity(5).map((entry) => entry.summary);
    assert.ok(activity.includes('#1 Anna uit label Speedteam Blue gehaald'));
    assert.ok(activity.includes('#1 Anna toegevoegd aan label Speedteam Blue'));
  } finally {
    db.closeDb();
  }
});
