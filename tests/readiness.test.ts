import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEventReadiness, readinessSummary } from '../src/lib/readiness.ts';
import { describeAutoLinks, deriveSystemStatus } from '../src/lib/systemStatus.ts';
import type { ClusterMemberStatus, ClusterStatus } from '../src/types.ts';

const now = Date.UTC(2026, 7, 3, 20, 0, 0);

function member(hostId: string, overrides: Partial<ClusterMemberStatus> = {}): ClusterMemberStatus {
  return {
    hostId,
    url: `http://${hostId}:5173`,
    name: hostId.toUpperCase(),
    self: hostId === 'host-a',
    leader: hostId === 'host-a',
    reachable: true,
    caughtUp: true,
    removable: false,
    ...overrides,
  };
}

function threeLaptops(overrides: Partial<ClusterStatus> = {}): ClusterStatus {
  return {
    enabled: true,
    hostId: 'host-a',
    hostName: 'HOST-A',
    clusterId: 'cluster',
    appVersion: '4.0.0',
    schemaVersion: 13,
    role: 'leader',
    term: 3,
    state: 'healthy',
    leader: { hostId: 'host-a', url: 'http://host-a:5173' },
    members: [member('host-a'), member('host-b'), member('host-c')],
    majority: 2,
    writable: true,
    busy: null,
    selfUrl: 'http://host-a:5173',
    logHead: 12,
    runners: 40,
    changed: true,
    memberUrls: ['http://host-b:5173', 'http://host-c:5173'],
    nearby: [],
    autoLink: { enabled: true, waiting: null, linked: [] },
    removedFrom: null,
    lastError: null,
    backup: {
      enabled: true,
      inProgress: false,
      intervalMs: 300_000,
      nextScheduledAt: now + 300_000,
      retainedCount: 2,
      latest: { fileName: 'backup.sqlite', createdAt: now - 60_000, sizeBytes: 1_024, scheduled: true },
      lastError: null,
      lastFailureAt: null,
      diskFreeBytes: 10 * 1_024 ** 3,
      minimumFreeBytes: 2 * 1_024 ** 3,
      diskLow: false,
      databaseBytes: 2_048,
    },
    ...overrides,
  };
}

test('three linked laptops with a fresh backup are ready', () => {
  assert.equal(readinessSummary(buildEventReadiness(threeLaptops(), now)), 'ready');
  const status = deriveSystemStatus(threeLaptops(), null, now);
  assert.equal(status?.tone, 'healthy');
  assert.equal(status?.detail, 'Gegevens op 3 laptops');
});

test('real safety failures block the event and a standalone installation only warns', () => {
  const cluster = threeLaptops();
  assert.equal(
    readinessSummary(buildEventReadiness({ ...cluster, backup: { ...cluster.backup, diskLow: true } }, now)),
    'blocked'
  );
  assert.equal(
    readinessSummary(buildEventReadiness({ ...cluster, state: 'solo', members: [member('host-a')] }, now)),
    'blocked'
  );
  assert.equal(readinessSummary(buildEventReadiness({ ...cluster, enabled: false }, now)), 'warning');
});

test('a missing laptop warns while the others carry on, and too few laptops block', () => {
  const degraded = threeLaptops({
    state: 'degraded',
    members: [member('host-a'), member('host-b'), member('host-c', { reachable: false, caughtUp: false })],
  });
  assert.equal(readinessSummary(buildEventReadiness(degraded, now)), 'warning');
  assert.match(
    buildEventReadiness(degraded, now).find((check) => check.id === 'replica')?.detail ?? '',
    /zet HOST-C weer aan/
  );
  assert.equal(deriveSystemStatus(degraded, null, now)?.title, 'Eén laptop onbereikbaar');

  const twoLaptops = threeLaptops({ members: [member('host-a'), member('host-b')] });
  assert.equal(readinessSummary(buildEventReadiness(twoLaptops, now)), 'warning');

  const stuck = threeLaptops({ state: 'no-majority', role: 'follower', writable: false, leader: null });
  assert.equal(readinessSummary(buildEventReadiness(stuck, now)), 'blocked');
  assert.equal(deriveSystemStatus(stuck, null, now)?.tone, 'error');
});

test('laptops that linked by themselves are named, this laptop first', () => {
  const cluster = threeLaptops({
    autoLink: {
      enabled: true,
      waiting: null,
      linked: [
        { hostId: 'host-c', name: 'HOST-C', self: false, with: 'HOST-A', at: now - 60_000 },
        { hostId: 'host-a', name: 'HOST-A', self: true, with: 'LAPTOP-TIJD', at: now - 3 * 60_000 },
      ],
    },
  });
  assert.deepEqual(
    describeAutoLinks(cluster, now).map((link) => link.text),
    ['Automatisch gekoppeld met LAPTOP-TIJD, 3 minuten geleden', 'HOST-C is automatisch bijgekomen, 1 minuut geleden']
  );
});
