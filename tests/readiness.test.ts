import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEventReadiness, readinessSummary } from '../src/lib/readiness.ts';
import { deriveSystemStatus } from '../src/lib/systemStatus.ts';
import type { ClusterStatus } from '../src/types.ts';

const now = Date.UTC(2026, 7, 3, 20, 0, 0);

function primaryWithStandby(overrides: Partial<ClusterStatus> = {}): ClusterStatus {
  return {
    enabled: true,
    hostId: 'host-a',
    clusterId: 'cluster',
    role: 'primary',
    epoch: 1,
    appVersion: '4.0.0',
    schemaVersion: 13,
    writable: true,
    busy: null,
    selfUrl: 'http://host-a:5173',
    logHead: 12,
    primary: null,
    standbys: [
      {
        hostId: 'host-b',
        url: 'http://host-b:5173',
        reachable: true,
        lastSeenAt: now,
        appliedSeq: 12,
        caughtUp: true,
      },
    ],
    memberUrls: ['http://host-b:5173'],
    competingPrimaryUrl: null,
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

test('a primary with a caught-up standby and fresh backup is ready', () => {
  assert.equal(readinessSummary(buildEventReadiness(primaryWithStandby(), now)), 'ready');
  assert.equal(deriveSystemStatus(primaryWithStandby(), null, now)?.tone, 'healthy');
});

test('real safety failures block the event and a standalone laptop only warns', () => {
  const cluster = primaryWithStandby();
  assert.equal(
    readinessSummary(buildEventReadiness({ ...cluster, backup: { ...cluster.backup, diskLow: true } }, now)),
    'blocked'
  );
  assert.equal(readinessSummary(buildEventReadiness({ ...cluster, standbys: [] }, now)), 'blocked');
  assert.equal(
    readinessSummary(buildEventReadiness({ ...cluster, competingPrimaryUrl: 'http://host-c:5173' }, now)),
    'blocked'
  );
  assert.equal(readinessSummary(buildEventReadiness({ ...cluster, enabled: false, standbys: [] }, now)), 'warning');
});

test('a standby reports whether its primary is reachable', () => {
  const standby = primaryWithStandby({
    role: 'standby',
    writable: false,
    standbys: [],
    primary: {
      url: 'http://host-a:5173',
      hostId: 'host-a',
      reachable: true,
      lastContactAt: now,
      head: 12,
      lagEntries: 0,
    },
  });
  assert.equal(readinessSummary(buildEventReadiness(standby, now)), 'ready');
  assert.equal(deriveSystemStatus(standby, null, now)?.title, 'Gekoppeld als standby');

  const orphaned = { ...standby, primary: { ...standby.primary!, reachable: false } };
  assert.equal(readinessSummary(buildEventReadiness(orphaned, now)), 'blocked');
  assert.equal(deriveSystemStatus(orphaned, null, now)?.tone, 'error');
});
