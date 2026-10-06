import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('race-db');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

test('finishing a race retires the active runner without recording an extra lap', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'First runner', runnerNumber: '1' });
    const second = db.insertRunner({ name: 'Second runner', runnerNumber: '2' });
    db.updateRunnerStatus({ id: first.id, status: 'waiting', statusSince: 900, queueIndex: 0 });
    db.updateRunnerStatus({ id: second.id, status: 'waiting', statusSince: 900, queueIndex: 1 });

    assert.deepEqual(db.performHandoff(1_000), {
      ok: true,
      lapId: null,
      startedRunnerId: first.id,
    });

    db.finishRace(2_000);

    assert.deepEqual(db.getRaceState(), {
      id: 1,
      activeRunnerId: null,
      activeStartedAt: null,
      raceStartedAt: 1_000,
      raceFinishedAt: 2_000,
      activeLabels: [],
    });
    assert.equal(db.getRunnerById(first.id)?.status, 'ran');
    assert.equal(db.getRunnerById(first.id)?.statusSince, 2_000);
    assert.equal(db.getRunnerById(first.id)?.lapCount, 0);
    assert.equal(db.getRunnerById(second.id)?.status, 'waiting');
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('undo after finishing reopens the race and keeps the laps', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const [zoe, arne] = ['Zoë', 'Arne'].map((name, index) =>
      db.insertRunner({ name, runnerNumber: String(index + 1) })
    );
    db.updateRunnerStatus({ id: zoe.id, status: 'waiting', statusSince: 1 });
    db.updateRunnerStatus({ id: arne.id, status: 'waiting', statusSince: 2 });
    db.performHandoff(1_000);
    const handoff = db.performHandoff(90_000);
    assert.equal(handoff.ok && handoff.startedRunnerId, arne.id);

    db.finishRace(120_000);
    assert.deepEqual(db.undoLastHandoff(), { ok: true, deletedLapIds: [] });

    assert.deepEqual(db.getRaceState(), {
      id: 1,
      activeRunnerId: arne.id,
      activeStartedAt: 90_000,
      raceStartedAt: 1_000,
      raceFinishedAt: null,
      activeLabels: [],
    });
    assert.equal(db.getRunnerById(arne.id)?.status, 'running');
    assert.equal(db.getRunnerById(arne.id)?.statusSince, 90_000);
    assert.equal(db.getRunnerById(zoe.id)?.status, 'ran');
    assert.equal(db.getRunnerById(zoe.id)?.lapCount, 1);

    // The next undo takes back the handoff before the finish, as usual.
    assert.deepEqual(db.undoLastHandoff(), { ok: true, deletedLapIds: handoff.ok ? [handoff.lapId] : [] });
    assert.equal(db.getRaceState().activeRunnerId, zoe.id);
    assert.equal(db.getRunnerById(zoe.id)?.lapCount, 0);
    assert.equal(db.getRunnerById(arne.id)?.status, 'waiting');
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('undo reverts the latest handoff when two share the same moment', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const [a, b, c] = ['A', 'B', 'C'].map((name, index) => {
      const runner = db.insertRunner({ name, runnerNumber: String(index + 1) });
      db.updateRunnerStatus({ id: runner.id, status: 'waiting', statusSince: 900, queueIndex: index });
      return runner;
    });

    db.performHandoff(1_000);
    db.performHandoff(61_000);
    // A press from a laptop whose clock runs behind is clamped to the previous handoff.
    db.performHandoff(61_000);
    assert.equal(db.getRaceState().activeRunnerId, c.id);

    assert.equal(db.undoLastHandoff().ok, true);

    assert.equal(db.getRaceState().activeRunnerId, b.id);
    assert.equal(db.getRaceState().activeStartedAt, 61_000);
    assert.equal(db.getAllLaps().length, 1);
    assert.equal(db.getRunnerById(a.id)?.status, 'ran');
    assert.equal(db.getRunnerById(b.id)?.status, 'running');
    assert.equal(db.getRunnerById(c.id)?.status, 'waiting');

    // A finish on that same moment is also the latest step, so undo reopens the race.
    db.finishRace(61_000);
    assert.equal(db.canUndoFinish(), true);
    assert.deepEqual(db.undoLastHandoff(), { ok: true, deletedLapIds: [] });
    assert.equal(db.getRaceState().raceFinishedAt, null);
    assert.equal(db.getRaceState().activeRunnerId, b.id);
    assert.equal(db.getAllLaps().length, 1);
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('reordering requires each waiting runner exactly once', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const runners = ['One', 'Two', 'Three'].map((name, index) => {
      const runner = db.insertRunner({ name, runnerNumber: String(index + 1) });
      db.updateRunnerStatus({ id: runner.id, status: 'waiting', statusSince: 1_000 + index, queueIndex: index });
      return runner;
    });

    assert.throws(() => db.updateWaitingOrder([runners[2].id, runners[1].id]), /volledige wachtrijvolgorde/);

    db.updateWaitingOrder([runners[2].id, runners[0].id, runners[1].id]);
    const queueIndexes = new Map(db.getAllRunners().map((runner) => [runner.id, runner.queueIndex]));
    assert.equal(queueIndexes.get(runners[2].id), 0);
    assert.equal(queueIndexes.get(runners[0].id), 1);
    assert.equal(queueIndexes.get(runners[1].id), 2);
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('timing mutations reject a stale race state instead of recording an extra handoff', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'First runner', runnerNumber: '1' });
    const second = db.insertRunner({ name: 'Second runner', runnerNumber: '2' });
    db.updateRunnerStatus({ id: first.id, status: 'waiting', statusSince: 900, queueIndex: 0 });
    db.updateRunnerStatus({ id: second.id, status: 'waiting', statusSince: 900, queueIndex: 1 });

    const caller = appRouter.createCaller({});
    const staleRace = { activeRunnerId: null, activeStartedAt: null };
    await caller.race.startNext(staleRace);

    await assert.rejects(caller.race.startNext(staleRace), /Timingstatus is gewijzigd/);
    assert.equal(db.getAllLaps().length, 0);
    assert.equal(db.getRaceState().activeRunnerId, first.id);
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('undo is refused after a finish without its own undo step, and keeps the laps and race state', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'First runner', runnerNumber: '1' });
    const second = db.insertRunner({ name: 'Second runner', runnerNumber: '2' });
    db.updateRunnerStatus({ id: first.id, status: 'waiting', statusSince: 900, queueIndex: 0 });
    db.updateRunnerStatus({ id: second.id, status: 'waiting', statusSince: 900, queueIndex: 1 });

    db.performHandoff(1_000);
    db.performHandoff(61_000);
    db.finishRace(90_000);
    const caller = appRouter.createCaller({});
    // Through the router, too, undo reopens a normal finish; finish again for the old case below.
    await caller.race.undoLastHandoff({ activeRunnerId: null, activeStartedAt: null });
    assert.equal(db.getRaceState().activeRunnerId, second.id);
    db.finishRace(90_000);
    // Races finished on an older build have no undo step for the finish.
    const file = new DatabaseSync(path.join(dataPath, 'data', 'app.db'));
    file.prepare('DELETE FROM handoff_history WHERE created_at = 90000').run();
    file.close();
    const finished = db.getRaceState();

    await assert.rejects(
      caller.race.undoLastHandoff({ activeRunnerId: null, activeStartedAt: null }),
      /De race is afgesloten/
    );
    assert.equal(db.getAllLaps().length, 1);
    assert.deepEqual(db.getRaceState(), finished);
    assert.equal(db.getRunnerById(first.id)?.status, 'ran');
    assert.equal(db.getRunnerById(second.id)?.status, 'ran');
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('only one runner can be marked as running', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'First runner', runnerNumber: '1' });
    const second = db.insertRunner({ name: 'Second runner', runnerNumber: '2' });

    db.updateRunnerStatus({ id: first.id, status: 'running', statusSince: 1_000 });
    assert.throws(
      () => db.updateRunnerStatus({ id: second.id, status: 'running', statusSince: 2_000 }),
      /Er loopt al een loper/
    );
    assert.equal(db.getRaceState().activeRunnerId, first.id);
    assert.equal(db.getRunnerById(second.id)?.status, 'registered');
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('a stale queue click cannot take the active runner off the track', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'First runner', runnerNumber: '1' });
    const second = db.insertRunner({ name: 'Second runner', runnerNumber: '2' });
    db.updateRunnerStatus({ id: first.id, status: 'waiting', statusSince: 900, queueIndex: 0 });
    db.updateRunnerStatus({ id: second.id, status: 'waiting', statusSince: 900, queueIndex: 1 });
    db.performHandoff(1_000);
    const liveRace = db.getRaceState();

    assert.throws(
      () => db.updateRunnerStatus({ id: first.id, status: 'warming_up', statusSince: 1_500 }),
      /Deze loper is net gestart op Timing/
    );
    const caller = appRouter.createCaller({});
    for (const status of ['registered', 'warming_up', 'waiting', 'ran'] as const) {
      await assert.rejects(caller.runners.setStatus({ id: first.id, status }), (error: Error & { code?: string }) => {
        assert.equal(error.code, 'CONFLICT');
        assert.match(error.message, /Wissel via het timingscherm/);
        return true;
      });
    }
    assert.deepEqual(db.getRaceState(), liveRace);
    assert.equal(db.getRunnerById(first.id)?.status, 'running');

    // The rest of the queue still moves, and Timing's own handoff keeps the live lap.
    await caller.runners.setStatus({ id: second.id, status: 'warming_up' });
    await caller.runners.setStatus({ id: second.id, status: 'waiting' });
    assert.equal(db.performHandoff(61_000).ok, true);
    assert.deepEqual(
      db.getAllLaps().map((lap) => [lap.runnerId, lap.durationMs]),
      [[first.id, 60_000]]
    );
    assert.equal(db.getRaceState().activeRunnerId, second.id);
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('new runners cannot bypass timing state and waiting runners join the back of the queue', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({
      name: 'First waiting runner',
      runnerNumber: '1',
      status: 'waiting',
    });
    const second = db.insertRunner({
      name: 'Second waiting runner',
      runnerNumber: '2',
      status: 'waiting',
    });

    assert.equal(db.getRunnerById(first.id)?.queueIndex, 0);
    assert.equal(db.getRunnerById(second.id)?.queueIndex, 1);
    assert.throws(() => db.insertRunner({ name: 'Invalid active runner', status: 'running' }), /timingscherm/);
    assert.equal(db.getRaceState().activeRunnerId, null);
    assert.equal(db.getAllRunners().length, 2);
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('undoing a handoff after a reorder keeps every waiting runner in its own place', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { getNextWaitingRunner } = await import('../src/lib/runners.ts');

  try {
    await db.initDb();
    const waiting = (name: string, runnerNumber: string, statusSince: number) => {
      const runner = db.insertRunner({ name, runnerNumber });
      db.updateRunnerStatus({ id: runner.id, status: 'waiting', statusSince });
      return runner;
    };
    const first = waiting('A', '1', 100);
    const restored = waiting('Zed', '2', 200);
    const last = waiting('C', '3', 300);

    db.performHandoff(1_000);
    db.updateWaitingOrder([restored.id, last.id]);
    assert.equal(db.performHandoff(2_000).ok && db.getRaceState().activeRunnerId, restored.id);
    // Ann sorts before Zed by name, so the old tie would make screens disagree with the server.
    const joined = waiting('Ann', '4', 2_500);
    db.updateWaitingOrder([joined.id, last.id]);

    assert.equal(db.undoLastHandoff().ok, true);

    const queue = db
      .getAllRunners()
      .filter((runner) => runner.status === 'waiting')
      .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0));
    assert.deepEqual(
      queue.map((runner) => [runner.id, runner.queueIndex]),
      [
        [restored.id, 0],
        [joined.id, 1],
        [last.id, 2],
      ]
    );
    assert.equal(db.getRaceState().activeRunnerId, first.id);
    assert.equal(getNextWaitingRunner(db.getAllRunners())?.id, restored.id);
    assert.equal(db.performHandoff(3_000).ok && db.getRaceState().activeRunnerId, restored.id);
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('label names are unique regardless of capitalization', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const label = db.createLabel({ name: 'Audit Team' });
    const other = db.createLabel({ name: 'Other Team' });

    assert.throws(() => db.createLabel({ name: 'audit team' }), /bestaat al/);
    assert.throws(() => db.updateLabel(other.id, { name: 'AUDIT TEAM' }), /bestaat al/);
    assert.equal(db.findLabelByName('aUdIt TeAm')?.id, label.id);
    assert.equal(db.getLabels().filter((item) => item.name.toLowerCase() === 'audit team').length, 1);
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('operational SQLite access paths stay indexed and runner lookups agree', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');

  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'Indexed runner', runnerNumber: '501', status: 'waiting' });
    const second = db.insertRunner({ name: 'Next runner', runnerNumber: '502', status: 'waiting' });
    db.performHandoff(1_000);
    db.performHandoff(61_000);

    assert.equal(db.getAllLaps().length, 1);
    assert.deepEqual(
      db.getRunnerById(first.id),
      db.getAllRunners().find((runner) => runner.id === first.id)
    );
    assert.ok(db.getRunnerById(second.id));

    const inspectionDb = new DatabaseSync(path.join(dataPath, 'data', 'app.db'), { readOnly: true });
    try {
      const indexNames = new Set(
        [
          ...inspectionDb.prepare("PRAGMA index_list('laps')").all(),
          ...inspectionDb.prepare("PRAGMA index_list('runners')").all(),
          ...inspectionDb.prepare("PRAGMA index_list('race_events')").all(),
        ].map((row) => String((row as { name: unknown }).name))
      );
      assert.ok(indexNames.has('idx_laps_runner_finished'));
      assert.ok(indexNames.has('idx_laps_finished'));
      assert.ok(indexNames.has('idx_runners_queue_order'));
      assert.ok(indexNames.has('idx_race_events_occurred'));
    } finally {
      inspectionDb.close();
    }
  } finally {
    // Windows cannot delete a database file that is still open.
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
