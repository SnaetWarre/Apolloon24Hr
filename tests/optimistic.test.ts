import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addPendingChange,
  confirmedSnapshot,
  orderPatch,
  statusPatch,
  waitingOrder,
  withPendingChanges,
} from '../src/app/optimistic.ts';
import type { LiveAppSnapshot, Runner, RunnerStatus } from '../src/types.ts';

function runner(id: string, status: RunnerStatus, queueIndex: number | null = null): Runner {
  return {
    id,
    runnerNumber: null,
    name: id,
    targetLaps: null,
    historicalAvgMs: null,
    historicalBestMs: null,
    registrationSource: 'manual',
    notes: '',
    estimatedPace: null,
    createdAt: 0,
    updatedAt: 0,
    status,
    statusSince: 0,
    queueIndex,
    hiddenFromQueue: false,
    queueHiddenAt: null,
    labels: [],
    lapCount: 0,
    lastLapMs: null,
    bestLapMs: null,
    slowestLapMs: null,
    averageLapMs: null,
    totalTimeMs: 0,
  };
}

function snapshot(runners: Runner[]): LiveAppSnapshot {
  return {
    runners,
    labels: [],
    temporaryTeams: [],
    race: {
      id: 1,
      activeRunnerId: null,
      activeStartedAt: null,
      raceStartedAt: null,
      raceFinishedAt: null,
      activeLabels: [],
    },
    settings: { publicRecordMode: 'day' },
    revision: 1,
    host: { hostIpHint: '', port: 1, url: '' },
  };
}

test('a runner sent to the queue joins at the back, and landing twice changes nothing', () => {
  const server = snapshot([runner('a', 'waiting', 0), runner('b', 'waiting', 1), runner('c', 'warming_up')]);
  const patch = statusPatch('c', 'waiting', 500);

  const once = patch(server);
  assert.deepEqual(waitingOrder(once), ['a', 'b', 'c']);
  assert.equal(once.runners.find((candidate) => candidate.id === 'c')?.statusSince, 500);
  // A refetch that already contains the change must not move the runner again.
  assert.deepEqual(waitingOrder(patch(once)), ['a', 'b', 'c']);
});

test('a runner sent back to warm up leaves the queue order', () => {
  const server = snapshot([runner('a', 'waiting', 0), runner('b', 'waiting', 1)]);
  const patched = statusPatch('a', 'warming_up', 500)(server);
  assert.deepEqual(waitingOrder(patched), ['b']);
  assert.equal(patched.runners.find((candidate) => candidate.id === 'a')?.queueIndex, null);
});

test('a new queue order is absolute, so reapplying it is harmless and newcomers keep their turn', () => {
  const server = snapshot([runner('a', 'waiting', 0), runner('b', 'waiting', 1), runner('c', 'waiting', 2)]);
  const patch = orderPatch(['c', 'a', 'b']);
  const once = patch(server);
  assert.deepEqual(waitingOrder(once), ['c', 'a', 'b']);
  assert.deepEqual(waitingOrder(patch(once)), ['c', 'a', 'b']);

  const withNewcomer = snapshot([...server.runners, runner('d', 'waiting', 3)]);
  assert.deepEqual(waitingOrder(patch(withNewcomer)), ['c', 'a', 'b', 'd']);
});

test('changes still in flight stay on top of every refetch until they are removed', () => {
  const server = snapshot([runner('a', 'waiting', 0), runner('b', 'warming_up')]);
  const remove = addPendingChange(statusPatch('b', 'waiting', 500));

  // A refetch that does not know about the click yet must not flip the runner back.
  assert.deepEqual(waitingOrder(withPendingChanges(server)), ['a', 'b']);
  assert.equal(confirmedSnapshot(), server);

  remove();
  assert.deepEqual(waitingOrder(withPendingChanges(server)), ['a']);
});

test('settling a queue move restores a runner started elsewhere and preserves other pending moves', () => {
  withPendingChanges(snapshot([runner('a', 'warming_up'), runner('b', 'warming_up')]));
  const removeA = addPendingChange(statusPatch('a', 'waiting', 500));
  const removeB = addPendingChange(statusPatch('b', 'waiting', 600));
  try {
    const server = snapshot([runner('a', 'running'), runner('b', 'warming_up')]);
    server.race.activeRunnerId = 'a';
    server.race.activeStartedAt = 700;
    server.revision = 3;
    assert.deepEqual(waitingOrder(withPendingChanges(server)), ['a', 'b']);

    const settled = removeA();
    assert.ok(settled);
    assert.equal(settled.runners.find((candidate) => candidate.id === 'a')?.status, 'running');
    assert.deepEqual(waitingOrder(settled), ['b']);
    assert.deepEqual(settled.race, server.race);
    assert.equal(settled.revision, server.revision);
    assert.deepEqual(removeB(), server);
  } finally {
    removeA();
    removeB();
  }
});

test('settling a reorder restores a newer queue order from another station', () => {
  const remove = addPendingChange(orderPatch(['b', 'a']));
  try {
    const server = snapshot([runner('a', 'waiting', 0), runner('b', 'waiting', 1)]);
    assert.deepEqual(waitingOrder(withPendingChanges(server)), ['b', 'a']);
    assert.deepEqual(remove(), server);
  } finally {
    remove();
  }
});
