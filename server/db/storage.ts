import { readPositiveNumber } from './values.js';
import { getDb, getAppDataRevision, DB_FILE, one, DATA_DIR, statementCache } from './connection.js';
import { getSetting, setSetting } from './settings.js';
import { type DatabaseStorageStatus } from '../../shared/schemas.js';
import fs from 'fs';

const COMPACTION_MIN_RECLAIMABLE_BYTES = readPositiveNumber(
  process.env.DATABASE_COMPACTION_MIN_BYTES,
  16 * 1_024 ** 2
);

const COMPACTION_MIN_RECLAIMABLE_RATIO = readPositiveNumber(
  process.env.DATABASE_COMPACTION_MIN_RATIO,
  0.25
);

export function databaseReadiness(): {
  ready: true;
  schemaVersion: number;
  revision: number;
} {
  const probe = getDb().prepare('SELECT 1 AS ready').get() as
    | { ready: number }
    | undefined;
  if (probe?.ready !== 1) throw new Error('database readiness probe failed');
  return {
    ready: true,
    schemaVersion: Number(getSetting('schema_version') || 0),
    revision: getAppDataRevision(),
  };
}

export function databaseStorageStatus(): DatabaseStorageStatus {
  const pageSize = Number(getDb().pragma('page_size', { simple: true })) || 0;
  const pageCount = Number(getDb().pragma('page_count', { simple: true })) || 0;
  const freePages = Number(getDb().pragma('freelist_count', { simple: true })) || 0;
  const fileBytes = fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : pageCount * pageSize;
  const reclaimableBytes = Math.min(fileBytes, Math.max(0, freePages * pageSize));
  const usedBytes = Math.max(0, fileBytes - reclaimableBytes);
  const reclaimablePercent = fileBytes > 0 ? (reclaimableBytes / fileBytes) * 100 : 0;
  const race = one<{
    activeRunnerId: string | null;
    raceStartedAt: number | null;
    raceFinishedAt: number | null;
  }>(
    `SELECT
       active_runner_id AS activeRunnerId,
       race_started_at AS raceStartedAt,
       race_finished_at AS raceFinishedAt
     FROM race_state
     WHERE id = 1`
  );
  const raceActive = Boolean(
    race?.activeRunnerId || (race?.raceStartedAt && !race?.raceFinishedAt)
  );
  return {
    fileBytes,
    usedBytes,
    reclaimableBytes,
    reclaimablePercent,
    compactionRecommended:
      reclaimableBytes >= COMPACTION_MIN_RECLAIMABLE_BYTES &&
      reclaimablePercent >= COMPACTION_MIN_RECLAIMABLE_RATIO * 100,
    raceActive,
    lastCompactedAt: parseStoredTimestamp(getSetting('last_database_compaction_at')),
  };
}

export function compactDatabaseIfSafe(options: { force?: boolean } = {}): {
  compacted: boolean;
  reason: 'compacted' | 'race-active' | 'not-needed' | 'insufficient-disk';
  before: DatabaseStorageStatus;
  after: DatabaseStorageStatus;
} {
  const before = databaseStorageStatus();
  if (before.raceActive) {
    return { compacted: false, reason: 'race-active', before, after: before };
  }
  if (!options.force && !before.compactionRecommended) {
    return { compacted: false, reason: 'not-needed', before, after: before };
  }
  try {
    const disk = fs.statfsSync(DATA_DIR);
    const freeBytes = Math.max(0, Math.trunc(disk.bavail * disk.bsize));
    if (freeBytes < before.fileBytes + 64 * 1_024 ** 2) {
      return { compacted: false, reason: 'insufficient-disk', before, after: before };
    }
  } catch {
    return { compacted: false, reason: 'insufficient-disk', before, after: before };
  }

  const quickCheck = getDb().pragma('quick_check', { simple: true });
  if (quickCheck !== 'ok') throw new Error(`database quick_check failed before compaction: ${quickCheck}`);
  statementCache.clear();
  getDb().exec('VACUUM');
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  setSetting('last_database_compaction_at', String(Date.now()));
  const afterCheck = getDb().pragma('quick_check', { simple: true });
  if (afterCheck !== 'ok') throw new Error(`database quick_check failed after compaction: ${afterCheck}`);
  const after = databaseStorageStatus();
  return { compacted: true, reason: 'compacted', before, after };
}

function parseStoredTimestamp(value: string | null): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
