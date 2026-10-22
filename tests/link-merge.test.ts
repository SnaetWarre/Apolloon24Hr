import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { RunnerRegistration } from '../shared/schemas.ts';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('link-merge');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

const db = await import('../server/db.ts');
type MergeData = Parameters<typeof db.mergeEventData>[0];
type IncomingRunner = MergeData['runners'][number];

function form(email: string, phone: string): RunnerRegistration {
  return {
    submittedAt: '4/10/2026 18:14:44',
    email,
    phone,
    studyPhase: '',
    estimatedLaps: '',
    estimatedPace: '',
    maxLapsPerBlock: '',
    availableHours: [],
    reuseConsent: '',
    flexibility: '',
    remarks: '',
    categories: [],
    fastestLap: '',
  };
}

/** A runner as the joining laptop sends it. */
function incoming(
  id: string,
  name: string,
  email = '',
  phone = '',
  runnerNumber: string | null = null
): IncomingRunner {
  return {
    id,
    runner_number: runnerNumber,
    name,
    target_laps: null,
    historical_avg_ms: null,
    historical_best_ms: null,
    registration_source: 'import',
    notes: '',
    registration_json: JSON.stringify(form(email, phone)),
    created_at: 1,
  };
}

function data(runners: IncomingRunner[], extra: Partial<MergeData> = {}): MergeData {
  return { from: 'LAPTOP-L', runners, labels: [], labelImages: [], runnerLabels: [], ...extra };
}

async function freshDb(): Promise<void> {
  db.closeDb();
  fs.rmSync(dataPath, { recursive: true, force: true });
  await db.initDb();
}

// Windows cannot delete a database file that is still open, so each test closes it before the folder goes.
test.afterEach(() => db.closeDb());

test('a runner is the same person only when name, e-mail and phone all match', async () => {
  await freshDb();
  const here = db.insertRunner({
    name: 'Jan Peeters',
    registration: form('Jan.Peeters@Example.be', '0475 12 34 56'),
  });
  const result = db.mergeEventData(
    data([
      // Case and the spaces around them differ, and the phone is written with dots and dashes.
      incoming('j1', '  jan peeters ', ' jan.peeters@example.be', '0475.12-34.56'),
      // One answer differs: another person, so a runner of their own.
      incoming('j2', 'Jan Peeters', 'jan.peeters@example.be', '0475 12 34 57'),
      incoming('j3', 'Jan Peeters', 'jan@example.be', '0475 12 34 56'),
      incoming('j4', 'Jan Pieters', 'jan.peeters@example.be', '0475 12 34 56'),
    ]),
    1_000
  );
  assert.deepEqual(result, { added: 3, same: 1, labels: 0 });
  const runners = db.getAllRunners();
  assert.equal(runners.length, 4);
  // The runner that was here stays exactly as it was typed here.
  const registrations = db.getRunnerRegistrations();
  assert.equal(registrations[here.id]?.email, 'Jan.Peeters@Example.be');
  assert.equal(registrations[here.id]?.phone, '0475 12 34 56');
  assert.equal(runners.find((runner) => runner.id === here.id)?.name, 'Jan Peeters');
  // An added runner keeps its answers as typed on the other laptop.
  assert.equal(registrations.j2?.phone, '0475 12 34 57');
});

test('a runner here stands for one runner from the other laptop, not two', async () => {
  await freshDb();
  db.insertRunner({ name: 'Noor', registration: form('', '') });
  const result = db.mergeEventData(data([incoming('n1', 'Noor'), incoming('n2', 'Noor')]), 1_000);
  assert.deepEqual(result, { added: 1, same: 1, labels: 0 });
  assert.equal(db.getAllRunners().length, 2);
});

test('linking a laptop with the same data twice adds nothing the second time', async () => {
  await freshDb();
  db.insertRunner({ name: 'Ann', runnerNumber: '1', registration: form('ann@example.be', '0470'), labels: ['Ploeg'] });
  db.insertRunner({ name: 'Bert', runnerNumber: '2' });
  const own = db.exportMergeData('LAPTOP-L');
  assert.deepEqual(db.mergeEventData(own, 1_000), { added: 0, same: 2, labels: 0 });
  assert.equal(db.getAllRunners().length, 2);
});

test('labels with the same name become one, and new labels come with their runners and logo', async () => {
  await freshDb();
  const here = db.createLabel({ name: 'Ploeg Rood', color: '#ff0000' });
  const imageId = 'abc123';
  const label = (id: string, name: string, image_url: string | null = null) => ({
    id,
    name,
    color: '#00ff00',
    icon: 'XX',
    kind: 'andere',
    image_url,
    target_laps: null,
    sort_order: null,
  });
  const result = db.mergeEventData(
    data([incoming('r1', 'Rik'), incoming('r2', 'Sara')], {
      labels: [label('rood', 'ploeg rood'), label('blauw', 'Ploeg Blauw', `/api/label-images/${imageId}`)],
      labelImages: [{ id: imageId, mime: 'image/png', data_base64: Buffer.from('logo').toString('base64') }],
      runnerLabels: [
        { runner_id: 'r1', label_id: 'rood' },
        { runner_id: 'r2', label_id: 'blauw' },
      ],
    }),
    1_000
  );
  assert.equal(result.labels, 1);
  const labels = db.getLabels().filter((candidate) => candidate.name.startsWith('Ploeg'));
  assert.deepEqual(labels.map((candidate) => [candidate.name, candidate.color]).sort(), [
    ['Ploeg Blauw', '#00ff00'],
    ['Ploeg Rood', '#ff0000'],
  ]);
  assert.deepEqual(db.getLabelImage(imageId)?.bytes.toString(), 'logo');
  const runners = db.getAllRunners();
  assert.deepEqual(
    runners.find((runner) => runner.id === 'r1')?.labels.map((candidate) => candidate.id),
    [here.id]
  );
  assert.deepEqual(
    runners.find((runner) => runner.id === 'r2')?.labels.map((candidate) => candidate.name),
    ['Ploeg Blauw']
  );
});

test('an added runner keeps its number unless a runner here has it, and joins as registered', async () => {
  await freshDb();
  const here = db.insertRunner({ name: 'Here', runnerNumber: '7', status: 'waiting' });
  db.mergeEventData(data([incoming(here.id, 'Other', '', '', '7'), incoming('free', 'Free', '', '', '8')]), 1_000);
  const runners = db.getAllRunners();
  const other = runners.find((runner) => runner.name === 'Other');
  assert.ok(other && other.id !== here.id, 'a taken id gets a new one');
  assert.equal(other.runnerNumber, null);
  assert.equal(other.status, 'registered');
  assert.equal(runners.find((runner) => runner.id === 'free')?.runnerNumber, '8');
});

test('nothing merges once the race started in the group', async () => {
  await freshDb();
  const [zoe, arne] = ['Zoë', 'Arne'].map((name) => db.insertRunner({ name }));
  let next = zoe;
  for (let lap = 0; lap <= db.RACE_COUNTS_FROM_LAPS; lap += 1) {
    db.updateRunnerStatus({ id: next.id, status: 'waiting', statusSince: lap });
    db.performHandoff(1_000 + lap * 80_000);
    next = next === zoe ? arne : zoe;
  }
  assert.throws(() => db.mergeEventData(data([incoming('late', 'Late')]), 1_000), /race al gestart/);
});

test('a race with fewer than ten laps is a test and does not stop a merge', async () => {
  await freshDb();
  const runner = db.insertRunner({ name: 'Tester', status: 'waiting' });
  db.performHandoff(1_000);
  db.performHandoff(2_000);
  assert.ok(db.getRaceState().raceStartedAt);
  assert.equal(db.getRunnerById(runner.id)?.lapCount, 1);
  assert.deepEqual(db.mergeEventData(data([incoming('late', 'Late')]), 3_000), { added: 1, same: 0, labels: 0 });
});
