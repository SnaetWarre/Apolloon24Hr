import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  RUNNER_MOVES,
  canMoveRace,
  canMoveRunner,
  canUndo,
  countedRaceProgress,
  nextLane,
  raceIsOpen,
  racePhase,
} from '../shared/lifecycle.ts';
import type { LiveAppSnapshot, RaceState, Runner, RunnerStatus } from '../shared/schemas.ts';
import { statusPatch } from '../src/app/optimistic.ts';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('lifecycle');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

type Db = typeof import('../server/db.ts');

async function withDb(check: (db: Db) => Promise<void> | void): Promise<void> {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    await check(db);
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
}

const race = (fields: Partial<RaceState>): RaceState => ({
  id: 1,
  activeRunnerId: null,
  activeStartedAt: null,
  raceStartedAt: null,
  raceFinishedAt: null,
  activeLabels: [],
  ...fields,
});

test('the race phases and the presses each one allows', () => {
  const notStarted = race({});
  const running = race({ raceStartedAt: 1, activeRunnerId: 'a', activeStartedAt: 1 });
  const idle = race({ raceStartedAt: 1 });
  const finished = race({ raceStartedAt: 1, raceFinishedAt: 2 });
  assert.deepEqual([notStarted, running, idle, finished].map(racePhase), [
    'not_started',
    'running',
    'idle',
    'finished',
  ]);

  assert.deepEqual(
    (['start', 'handoff', 'finish', 'resume'] as const).map((move) => [
      move,
      [notStarted, running, idle, finished].map((state) => canMoveRace(state, move)),
    ]),
    [
      ['start', [true, false, true, false]],
      ['handoff', [false, true, false, false]],
      ['finish', [false, true, true, false]],
      ['resume', [false, false, false, true]],
    ]
  );

  // Open means started and not finished; linking laptops only count it from ten laps on.
  assert.deepEqual([notStarted, running, idle, finished].map(raceIsOpen), [false, true, true, false]);
  assert.deepEqual(countedRaceProgress(9, running), { raceStarted: false, raceRunning: false });
  assert.deepEqual(countedRaceProgress(10, running), { raceStarted: true, raceRunning: true });
  assert.deepEqual(countedRaceProgress(10, finished), { raceStarted: true, raceRunning: false });

  // A finished race only undoes its own finish.
  assert.equal(canUndo(finished, 'finish'), true);
  assert.equal(canUndo(finished, 'handoff'), false);
  assert.equal(canUndo(running, 'handoff'), true);
  assert.equal(canUndo(running, null), false);
});

test('the lanes an operator moves runners between', () => {
  const statuses: RunnerStatus[] = ['registered', 'warming_up', 'waiting', 'running', 'ran'];
  const allowed = statuses.flatMap((from) =>
    statuses.filter((to) => canMoveRunner(from, to)).map((to) => `${from}>${to}`)
  );
  assert.deepEqual(allowed, [
    'registered>warming_up',
    'registered>waiting',
    'warming_up>registered',
    'warming_up>waiting',
    'waiting>registered',
    'waiting>warming_up',
    'ran>warming_up',
    'ran>waiting',
  ]);
  assert.deepEqual(RUNNER_MOVES.running, []);
  assert.deepEqual(statuses.map(nextLane), ['warming_up', 'waiting', 'warming_up', null, 'warming_up']);
});

test('after Race beëindigen a press starts the next runner only when it says it resumes the race', async () => {
  await withDb(async (db) => {
    const { appRouter } = await import('../server/router.ts');
    const caller = appRouter.createCaller({});
    const [anna, bert] = ['Anna', 'Bert'].map((name, index) =>
      db.insertRunner({ name, runnerNumber: String(index + 1) })
    );
    db.updateRunnerStatus({ id: anna.id, status: 'waiting', statusSince: 0 });
    db.performHandoff(1_000);
    db.finishRace(61_000);
    db.updateRunnerStatus({ id: bert.id, status: 'waiting', statusSince: 62_000 });
    const finished = db.getRaceState();
    const press = { activeRunnerId: null, activeStartedAt: null };

    await assert.rejects(caller.race.startNext(press), /Bevestig eerst dat je de race hervat/);
    await assert.rejects(caller.race.handoff(press), /Bevestig eerst dat je de race hervat/);
    assert.deepEqual(db.getRaceState(), finished);
    assert.equal(db.getRunnerById(bert.id)?.status, 'waiting');
    assert.equal(db.nextUndo(), 'finish');

    await caller.race.startNext({ ...press, resume: true });
    assert.equal(racePhase(db.getRaceState()), 'running');
    assert.equal(db.getRaceState().activeRunnerId, bert.id);
    assert.equal(db.getRaceState().raceStartedAt, 1_000);

    // Undoing the resume finishes the race again, and the next undo is the finish itself.
    assert.equal(db.nextUndo(), 'handoff');
    assert.equal(db.undoLastHandoff().ok, true);
    assert.deepEqual(db.getRaceState(), finished);
    assert.equal(db.nextUndo(), 'finish');
    assert.equal(db.undoLastHandoff().ok, true);
    assert.equal(racePhase(db.getRaceState()), 'running');
    assert.equal(db.getRaceState().activeRunnerId, anna.id);
  });
});

test('an undo step stored before steps had a kind is still read as a handoff or the finish', async () => {
  await withDb(async (db) => {
    const anna = db.insertRunner({ name: 'Anna', runnerNumber: '1' });
    db.updateRunnerStatus({ id: anna.id, status: 'waiting', statusSince: 0 });
    db.performHandoff(1_000);
    db.finishRace(61_000);
    const { getDb } = await import('../server/db/connection.ts');
    getDb().exec(`UPDATE handoff_history SET payload_json = json_remove(payload_json, '$.kind')`);

    assert.equal(db.nextUndo(), 'finish');
    assert.equal(db.undoLastHandoff().ok, true);
    assert.equal(db.nextUndo(), 'handoff');
  });
});

test('Wachtrij and its screen agree on a repeated move: the runner keeps their place', async () => {
  await withDb((db) => {
    const [anna, bert] = ['Anna', 'Bert'].map((name, index) =>
      db.insertRunner({ name, runnerNumber: String(index + 1) })
    );
    db.updateRunnerStatus({ id: anna.id, status: 'waiting', statusSince: 1 });
    db.updateRunnerStatus({ id: bert.id, status: 'waiting', statusSince: 2 });
    const before = db.getAllRunners();

    db.updateRunnerStatus({ id: anna.id, status: 'waiting', statusSince: 3 });
    assert.deepEqual(db.getAllRunners(), before);

    const snapshot = { runners: before, race: race({}) } as unknown as LiveAppSnapshot;
    assert.equal(statusPatch(anna.id, 'waiting', 3)(snapshot), snapshot);
    // A move the server refuses does not show on the screen either.
    const ran = { ...snapshot, runners: before.map((runner): Runner => ({ ...runner, status: 'ran' })) };
    assert.equal(statusPatch(anna.id, 'registered', 3)(ran), ran);
  });
});

test('a restore refuses a backup whose race is in no phase at all', async () => {
  await withDb((db) => {
    const anna = db.insertRunner({ name: 'Anna', runnerNumber: '1' });
    const raceRow = {
      id: 1,
      active_runner_id: anna.id,
      active_started_at: 2_000,
      race_started_at: 1_000,
      race_finished_at: 3_000,
      active_labels_json: null,
    };
    const empty = {
      label_images: [],
      labels: [],
      runners: [],
      runner_labels: [],
      laps: [],
      handoff_history: [],
      race_events: [],
    };
    assert.throws(
      () =>
        db.replaceEventData({
          fileName: 'damaged.sqlite',
          backupCreatedAt: 0,
          tables: { ...empty, race_state: [raceRow] },
          settings: [],
        }),
      /beschadigd: de race heeft een loper op de piste na het einde/
    );
    assert.equal(db.getRunnerById(anna.id)?.name, 'Anna');
  });
});
