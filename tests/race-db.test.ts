import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const dataPath = path.resolve(`.tmp-test-race-db-${process.pid}`);
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

    const inspectionDb = new Database(path.join(dataPath, 'data', 'app.db'), { readonly: true });
    try {
      const indexNames = new Set(
        [
          ...inspectionDb.prepare("PRAGMA index_list('laps')").all(),
          ...inspectionDb.prepare("PRAGMA index_list('queue_entries')").all(),
          ...inspectionDb.prepare("PRAGMA index_list('race_events')").all(),
        ].map((row) => String((row as { name: unknown }).name))
      );
      assert.ok(indexNames.has('idx_laps_runner_finished'));
      assert.ok(indexNames.has('idx_laps_finished'));
      assert.ok(indexNames.has('idx_queue_status_order'));
      assert.ok(indexNames.has('idx_race_events_occurred'));
    } finally {
      inspectionDb.close();
    }
  } finally {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
