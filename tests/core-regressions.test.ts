import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { Active, CollisionDetection, DroppableContainer } from '@dnd-kit/core';
import { buildTimeBuckets } from '../src/lib/analysis.ts';
import { kanbanCollisionDetection, resolveKanbanDrop } from '../src/lib/kanban.ts';
import type { LapRecord, RaceState } from '../src/types.ts';

const dataPath = path.resolve(`.tmp-test-core-regressions-${process.pid}`);
process.env.DATA_PATH = dataPath;
type ClientRect = Parameters<CollisionDetection>[0]['collisionRect'];

test('analysis hour buckets use Brussels clock hours from the race start', () => {
  const raceStartedAt = Date.parse('2026-10-20T20:00:00+02:00');
  const race = {
    id: 1,
    activeRunnerId: null,
    activeStartedAt: null,
    raceStartedAt,
    raceFinishedAt: null,
    activeLabels: [],
  } satisfies RaceState;
  const lap = (id: string, finishedAt: number): LapRecord => ({
    id,
    runnerId: 'runner-1',
    runnerName: 'Runner',
    runnerNumber: '1',
    startedAt: finishedAt - 60_000,
    finishedAt,
    durationMs: 60_000,
    labels: [],
  });

  const buckets = buildTimeBuckets(
    [
      lap('lap-1', raceStartedAt + 30 * 60_000),
      lap('lap-2', raceStartedAt + 3.5 * 3_600_000),
      lap('lap-3', raceStartedAt + 4.5 * 3_600_000),
    ],
    race
  );

  assert.deepEqual(
    buckets.map((bucket) => bucket.label),
    ['20u-21u', '23u-00u', '00u-01u']
  );
});

test('dragging a warming-up runner into an empty or populated waiting column sets waiting status', () => {
  const warmingRunner = { id: 'warming-runner', status: 'warming_up' as const };
  const waitingRunner = { id: 'waiting-runner', status: 'waiting' as const };

  assert.deepEqual(resolveKanbanDrop(warmingRunner.id, 'column-waiting', [warmingRunner]), {
    type: 'set-status',
    runnerId: warmingRunner.id,
    status: 'waiting',
  });
  assert.deepEqual(resolveKanbanDrop(warmingRunner.id, waitingRunner.id, [warmingRunner, waitingRunner]), {
    type: 'set-status',
    runnerId: warmingRunner.id,
    status: 'waiting',
  });
});

test('kanban collision detection targets the exact empty column or runner under the pointer', () => {
  const active = {
    id: 'warming-runner',
    data: { current: undefined },
    rect: { current: { initial: null, translated: null } },
  } satisfies Active;
  const rect = (left: number, top: number, width: number, height: number): ClientRect => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  const container = (id: string, bounds: ClientRect): DroppableContainer => ({
    id,
    key: id,
    disabled: false,
    data: { current: undefined },
    node: { current: null },
    rect: { current: bounds },
  });
  const warmingColumnRect = rect(0, 0, 300, 800);
  const waitingColumnRect = rect(320, 0, 300, 800);
  const waitingRunnerRect = rect(330, 100, 280, 100);
  const warmingColumn = container('column-warming_up', warmingColumnRect);
  const waitingColumn = container('column-waiting', waitingColumnRect);

  const emptyColumnCollision = kanbanCollisionDetection({
    active,
    collisionRect: rect(350, 500, 280, 100),
    droppableContainers: [warmingColumn, waitingColumn],
    droppableRects: new Map([
      [warmingColumn.id, warmingColumnRect],
      [waitingColumn.id, waitingColumnRect],
    ]),
    pointerCoordinates: { x: 450, y: 550 },
  });
  assert.equal(emptyColumnCollision[0]?.id, 'column-waiting');

  const waitingRunner = container('waiting-runner', waitingRunnerRect);
  const populatedColumnCollision = kanbanCollisionDetection({
    active,
    collisionRect: rect(330, 100, 280, 100),
    droppableContainers: [warmingColumn, waitingColumn, waitingRunner],
    droppableRects: new Map([
      [warmingColumn.id, warmingColumnRect],
      [waitingColumn.id, waitingColumnRect],
      [waitingRunner.id, waitingRunnerRect],
    ]),
    pointerCoordinates: { x: 450, y: 150 },
  });
  assert.equal(populatedColumnCollision[0]?.id, 'waiting-runner');
});

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

    assert.throws(
      () => db.updateWaitingOrder([runners[2].id, runners[1].id]),
      /volledige wachtrijvolgorde/
    );

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
