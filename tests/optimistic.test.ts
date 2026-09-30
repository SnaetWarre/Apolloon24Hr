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
