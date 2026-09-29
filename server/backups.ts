import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupRecordSchema, type BackupRecord, type BackupStatus } from '../shared/schemas.js';
import { backupDatabase, compactDatabaseIfSafe, databaseStorageStatus, ensureReplicationIdentity } from './db.js';
import { DATA_ROOT, readPositiveInt } from './env.js';

type BackupManifest = {
  formatVersion: 1;
  application: 'Apolloon';
  backup: BackupRecord;
  verification: {
    hashAlgorithm: 'SHA-256';
    sqliteQuickCheck: 'ok';
    foreignKeyCheck: 'ok';
  };
};

const backupDirectory = path.join(DATA_ROOT, 'backups');
const enabled =
  process.env.BACKUP_ENABLED === 'true' || (process.env.BACKUP_ENABLED !== 'false' && process.env.NODE_ENV !== 'test');
const intervalMs = readPositiveInt(process.env.BACKUP_INTERVAL_MS, 5 * 60_000);
const initialDelayMs = readPositiveInt(process.env.BACKUP_INITIAL_DELAY_MS, 10_000);
const minimumFreeBytes = readPositiveInt(process.env.BACKUP_MIN_FREE_BYTES, 2 * 1_024 ** 3);
const maximumRetainedBytes = readPositiveInt(process.env.BACKUP_MAX_TOTAL_BYTES, 8 * 1_024 ** 3);

let records: BackupRecord[] = [];
let activeBackup: Promise<BackupRecord> | null = null;
let queuedBackup: Promise<BackupRecord> | null = null;
let scheduleHandle: NodeJS.Timeout | null = null;
let nextScheduledAt: number | null = null;
let stopping = false;
let lastFailureAt: number | null = null;
let lastError: string | null = null;
let maintenanceInProgress = false;

export function backupStatus(): BackupStatus {
  const storage = backupStorageCapacity();
  return {
    enabled,
    inProgress: activeBackup !== null,
    queued: queuedBackup !== null,
    maintenanceInProgress,
    intervalMs,
    nextScheduledAt,
    retainedCount: records.length,
    retainedBytes: records.reduce((total, record) => total + record.sizeBytes, 0),
    maximumRetainedBytes,
    latest: records[0] || null,
    lastFailureAt,
    lastError,
    diskFreeBytes: storage?.freeBytes ?? null,
    diskTotalBytes: storage?.totalBytes ?? null,
    minimumFreeBytes,
    diskLow: storage ? storage.freeBytes < minimumFreeBytes : false,
    database: databaseStorageStatus(),
  };
}

export function startBackupService(): void {
  refreshBackupInventory();
  if (!enabled || scheduleHandle || activeBackup) return;
  stopping = false;
  scheduleNext(initialDelayMs);
}

export async function stopBackupService(): Promise<void> {
  stopping = true;
  if (scheduleHandle) clearTimeout(scheduleHandle);
  scheduleHandle = null;
  nextScheduledAt = null;
  // A failure is already exposed through backupStatus().
  await (queuedBackup || activeBackup)?.catch(() => undefined);
}

/**
 * Serializes backups: a scheduled request joins the running one, any other
 * request queues (at most one) behind it so it captures the latest state.
 */
export function createVerifiedBackup(reason = 'manual'): Promise<BackupRecord> {
  if (maintenanceInProgress) {
    return Promise.reject(new Error('databaseonderhoud is bezig; probeer de backup zo opnieuw'));
  }
  const normalizedReason = safeReason(reason);
  if (!activeBackup) return startVerifiedBackup(normalizedReason);
  if (normalizedReason === 'scheduled') return activeBackup;
  queuedBackup ??= activeBackup
    .catch(() => undefined)
    .then(() => startVerifiedBackup(normalizedReason))
    .finally(() => {
      queuedBackup = null;
    });
  return queuedBackup;
}

/**
 * Compacts the live database behind a verified safety backup. Without `force`
 * (startup) it only runs when worthwhile; forced (Admin) it refuses during a race.
 */
export async function compactDatabaseStorage({ force = true }: { force?: boolean } = {}): Promise<
  ReturnType<typeof compactDatabaseIfSafe>
> {
  const storage = databaseStorageStatus();
  if (storage.raceActive && force) {
    throw new Error('Database compactie is geblokkeerd zolang de race actief is.');
  }
  if (storage.raceActive || (!force && !storage.compactionRecommended)) {
    return compactDatabaseIfSafe();
  }
  await createVerifiedBackup('pre-database-compaction');
  maintenanceInProgress = true;
  try {
    return compactDatabaseIfSafe({ force });
  } finally {
    maintenanceInProgress = false;
  }
}

function startVerifiedBackup(reason: string): Promise<BackupRecord> {
  activeBackup = performBackup(reason)
    .catch((error) => {
      lastFailureAt = Date.now();
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      activeBackup = null;
    });
  return activeBackup;
}

export function latestBackupPath(): { record: BackupRecord; path: string } | null {
  const record = records[0];
  if (!record) return null;
  const filePath = path.join(backupDirectory, record.fileName);
  return fs.existsSync(filePath) ? { record, path: filePath } : null;
}

export function backupManifest(record: BackupRecord): BackupManifest {
  return {
    formatVersion: 1,
    application: 'Apolloon',
    backup: record,
    verification: {
      hashAlgorithm: 'SHA-256',
      sqliteQuickCheck: 'ok',
      foreignKeyCheck: 'ok',
    },
  };
}

export async function verifyStoredBackup(record: BackupRecord, filePath: string): Promise<void> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size !== record.sizeBytes) {
      throw new Error('backup size no longer matches its manifest');
    }
    const sha256 = await hashFile(filePath);
    if (!safeEqualHex(sha256, record.sha256)) {
      throw new Error('backup SHA-256 no longer matches its manifest');
    }
    try {
      verifyBackup(filePath);
    } finally {
      await removeBackupSidecars(filePath);
    }
  } catch (error) {
    lastFailureAt = Date.now();
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export function backupsToRetain(
  candidates: BackupRecord[],
  now = Date.now(),
  maximumBytes = Number.POSITIVE_INFINITY
): Set<string> {
  const sorted = candidates.slice().sort((a, b) => b.createdAt - a.createdAt);
  const keep = new Set<string>();
  const manual = sorted.filter((record) => record.reason !== 'scheduled');
  for (const record of manual.slice(0, 20)) keep.add(record.fileName);

  const automatic = sorted.filter((record) => record.reason === 'scheduled');
  for (const record of automatic.slice(0, 24)) keep.add(record.fileName);

  const hourly = new Set<string>();
  const daily = new Set<string>();
  for (const record of automatic.slice(24)) {
    const age = Math.max(0, now - record.createdAt);
    if (age <= 72 * 60 * 60_000) {
      const key = new Date(record.createdAt).toISOString().slice(0, 13);
      if (!hourly.has(key)) {
        hourly.add(key);
        keep.add(record.fileName);
      }
      continue;
    }
    if (age <= 30 * 24 * 60 * 60_000) {
      const key = new Date(record.createdAt).toISOString().slice(0, 10);
      if (!daily.has(key)) {
        daily.add(key);
        keep.add(record.fileName);
      }
    }
  }
  const protectedFiles = new Set(
    [sorted[0], manual[0], automatic[0]]
      .filter((record): record is BackupRecord => Boolean(record))
      .map((record) => record.fileName)
  );
  let retainedBytes = sorted
    .filter((record) => keep.has(record.fileName))
    .reduce((total, record) => total + record.sizeBytes, 0);
  const removable = sorted
    .filter((record) => keep.has(record.fileName) && !protectedFiles.has(record.fileName))
    .sort((left, right) => {
      const leftManual = left.reason === 'scheduled' ? 0 : 1;
      const rightManual = right.reason === 'scheduled' ? 0 : 1;
      return leftManual - rightManual || left.createdAt - right.createdAt;
    });
  for (const record of removable) {
    if (retainedBytes <= maximumBytes) break;
    keep.delete(record.fileName);
    retainedBytes -= record.sizeBytes;
  }
  return keep;
}

async function performBackup(reason: string): Promise<BackupRecord> {
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  const createdAt = Date.now();
  const hostSuffix = ensureReplicationIdentity()
    .hostId.replace(/[^a-z0-9]/gi, '')
    .slice(0, 8);
  const stamp = new Date(createdAt).toISOString().replace(/[-:.]/g, '');
  const fileName = `apolloon-${stamp}-${hostSuffix}-${reason}-${crypto.randomUUID().slice(0, 8)}.sqlite`;
  const finalPath = path.join(backupDirectory, fileName);
  const partialPath = `${finalPath}.partial`;
  let published = false;

  try {
    await backupDatabase(partialPath);
    verifyBackup(partialPath);
    compactBackupCopy(partialPath);
    verifyBackup(partialPath);
    await removeBackupSidecars(partialPath);
    await syncFile(partialPath);
    await fs.promises.rename(partialPath, finalPath);
    const [stat, sha256] = await Promise.all([fs.promises.stat(finalPath), hashFile(finalPath)]);
    const record: BackupRecord = {
      fileName,
      createdAt,
      reason,
      sizeBytes: stat.size,
      sha256,
      verified: true,
    };
    await writeMetadata(record);
    records = [record, ...records.filter((item) => item.fileName !== fileName)].sort(
      (a, b) => b.createdAt - a.createdAt
    );
    published = true;
    await pruneBackups().catch((error) => {
      console.warn('Old database backups could not be pruned:', error instanceof Error ? error.message : String(error));
    });
    lastError = null;
    return record;
  } catch (error) {
    await removePartialBackup(partialPath).catch(() => undefined);
    if (!published) {
      await Promise.all([
        fs.promises.rm(finalPath, { force: true }),
        fs.promises.rm(`${finalPath}.json`, { force: true }),
      ]).catch(() => undefined);
    }
    throw error;
  }
}

function compactBackupCopy(filePath: string): void {
  const backup = new Database(filePath, { fileMustExist: true });
  try {
    backup.pragma('busy_timeout = 5000');
    backup.pragma('synchronous = FULL');
    backup.pragma('journal_mode = DELETE');
    backup.exec('VACUUM');
  } finally {
    backup.close();
  }
}

function verifyBackup(filePath: string): void {
  const verifier = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = verifier.pragma('quick_check') as Array<Record<string, unknown>>;
    const checkValues = quickCheck.flatMap((row) => Object.values(row));
    if (checkValues.length !== 1 || checkValues[0] !== 'ok') {
      throw new Error(`backup quick_check failed: ${checkValues.join(', ')}`);
    }
    const foreignKeyFailures = verifier.pragma('foreign_key_check') as unknown[];
    if (foreignKeyFailures.length) {
      throw new Error(`backup contains ${foreignKeyFailures.length} foreign-key violation(s)`);
    }
  } finally {
    verifier.close();
  }
}

function refreshBackupInventory(): void {
  fs.mkdirSync(backupDirectory, { recursive: true });
  for (const entry of fs.readdirSync(backupDirectory)) {
    if (/\.partial(?:-(?:shm|wal))?$/.test(entry)) {
      fs.rmSync(path.join(backupDirectory, entry), { force: true });
    }
  }
  records = fs
    .readdirSync(backupDirectory)
    .filter((entry) => entry.endsWith('.sqlite.json'))
    .flatMap((entry) => {
      try {
        const parsed = backupRecordSchema.safeParse(
          JSON.parse(fs.readFileSync(path.join(backupDirectory, entry), 'utf8'))
        );
        if (!parsed.success || !parsed.data.fileName.endsWith('.sqlite')) return [];
        const filePath = path.join(backupDirectory, parsed.data.fileName);
        return fs.existsSync(filePath) && fs.statSync(filePath).size === parsed.data.sizeBytes ? [parsed.data] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function pruneBackups(): Promise<void> {
  const keep = backupsToRetain(records, Date.now(), maximumRetainedBytes);
  const removed = records.filter((record) => !keep.has(record.fileName));
  records = records.filter((record) => keep.has(record.fileName));
  await Promise.all(
    removed.flatMap((record) => [
      fs.promises.rm(path.join(backupDirectory, record.fileName), { force: true }),
      fs.promises.rm(path.join(backupDirectory, `${record.fileName}.json`), { force: true }),
    ])
  );
}

function scheduleNext(delayMs: number): void {
  if (!enabled || stopping) return;
  nextScheduledAt = Date.now() + delayMs;
  scheduleHandle = setTimeout(() => {
    scheduleHandle = null;
    nextScheduledAt = null;
    void createVerifiedBackup('scheduled')
      .catch((error) => {
        console.warn('Scheduled database backup failed:', error instanceof Error ? error.message : String(error));
      })
      .finally(() => scheduleNext(intervalMs));
  }, delayMs);
  scheduleHandle.unref();
}

async function writeMetadata(record: BackupRecord): Promise<void> {
  const metadataPath = path.join(backupDirectory, `${record.fileName}.json`);
  const partialPath = `${metadataPath}.partial`;
  await fs.promises.writeFile(partialPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await syncFile(partialPath);
  await fs.promises.rename(partialPath, metadataPath);
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeBackupSidecars(filePath: string): Promise<void> {
  await Promise.all([
    fs.promises.rm(`${filePath}-shm`, { force: true }),
    fs.promises.rm(`${filePath}-wal`, { force: true }),
  ]);
}

async function removePartialBackup(filePath: string): Promise<void> {
  await Promise.all([fs.promises.rm(filePath, { force: true }), removeBackupSidecars(filePath)]);
}

function safeReason(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, 32) || 'manual';
}

function backupStorageCapacity(): { freeBytes: number; totalBytes: number } | null {
  try {
    const stats = fs.statfsSync(backupDirectory);
    return {
      freeBytes: Math.max(0, Math.trunc(stats.bavail * stats.bsize)),
      totalBytes: Math.max(0, Math.trunc(stats.blocks * stats.bsize)),
    };
  } catch {
    return null;
  }
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
