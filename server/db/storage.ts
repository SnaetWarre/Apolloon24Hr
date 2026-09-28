import fs from 'node:fs';
import { type DatabaseStorageStatus } from '../../shared/schemas.js';
import { readPositiveNumber } from '../env.js';
import { DATA_DIR, DB_FILE, getAppDataRevision, getDb, statementCache } from './connection.js';
import { isRaceActive } from './race-state.js';
import { getSetting, setLocalSetting } from './settings.js';

const COMPACTION_MIN_RECLAIMABLE_BYTES = readPositiveNumber(process.env.DATABASE_COMPACTION_MIN_BYTES, 16 * 1_024 ** 2);

const COMPACTION_MIN_RECLAIMABLE_RATIO = readPositiveNumber(process.env.DATABASE_COMPACTION_MIN_RATIO, 0.25);

/** VACUUM writes a full copy of the database, so keep this much headroom beyond it. */
const COMPACTION_DISK_HEADROOM_BYTES = 64 * 1_024 ** 2;

export function databaseReadiness(): { ready: true; schemaVersion: number; revision: number } {
  const probe = getDb().prepare('SELECT 1 AS ready').get() as { ready: number } | undefined;
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
  const reclaimablePercent = fileBytes > 0 ? (reclaimableBytes / fileBytes) * 100 : 0;
  const lastCompactedAt = Number(getSetting('last_database_compaction_at'));
  return {
    fileBytes,
    usedBytes: Math.max(0, fileBytes - reclaimableBytes),
    reclaimableBytes,
    reclaimablePercent,
    compactionRecommended:
      reclaimableBytes >= COMPACTION_MIN_RECLAIMABLE_BYTES &&
      reclaimablePercent >= COMPACTION_MIN_RECLAIMABLE_RATIO * 100,
    raceActive: isRaceActive(),
    lastCompactedAt: Number.isSafeInteger(lastCompactedAt) && lastCompactedAt > 0 ? lastCompactedAt : null,
  };
}

function freeDiskBytes(): number | null {
  try {
    const disk = fs.statfsSync(DATA_DIR);
    return Math.max(0, Math.trunc(disk.bavail * disk.bsize));
  } catch {
    return null;
  }
}

/** Never compacts during a race; without `force`, only when enough space is reclaimable. */
export function compactDatabaseIfSafe(options: { force?: boolean } = {}): {
  compacted: boolean;
  reason: 'compacted' | 'race-active' | 'not-needed' | 'insufficient-disk';
  before: DatabaseStorageStatus;
  after: DatabaseStorageStatus;
} {
  const before = databaseStorageStatus();
  const skip = (reason: 'race-active' | 'not-needed' | 'insufficient-disk') => ({
    compacted: false,
    reason,
    before,
    after: before,
  });
  if (before.raceActive) return skip('race-active');
  if (!options.force && !before.compactionRecommended) return skip('not-needed');
  const freeBytes = freeDiskBytes();
  if (freeBytes === null || freeBytes < before.fileBytes + COMPACTION_DISK_HEADROOM_BYTES) {
    return skip('insufficient-disk');
  }

  assertQuickCheck('before');
  statementCache.clear();
  getDb().exec('VACUUM');
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  setLocalSetting('last_database_compaction_at', String(Date.now()));
  assertQuickCheck('after');
  return { compacted: true, reason: 'compacted', before, after: databaseStorageStatus() };
}

function assertQuickCheck(stage: 'before' | 'after'): void {
  const result = getDb().pragma('quick_check', { simple: true });
  if (result !== 'ok') throw new Error(`database quick_check failed ${stage} compaction: ${result}`);
}
