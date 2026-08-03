import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabase, ensureReplicationIdentity } from './db.js';

export type BackupRecord = {
  fileName: string;
  createdAt: number;
  reason: string;
  sizeBytes: number;
  sha256: string;
  verified: true;
};

export type BackupStatus = {
  enabled: boolean;
  inProgress: boolean;
  intervalMs: number;
  nextScheduledAt: number | null;
  retainedCount: number;
  latest: BackupRecord | null;
  lastFailureAt: number | null;
  lastError: string | null;
};

const dataRoot = process.env.DATA_PATH
  ? path.resolve(process.env.DATA_PATH)
  : path.resolve(process.cwd());
const backupDirectory = path.join(dataRoot, 'backups');
const enabled =
  process.env.BACKUP_ENABLED === 'true' ||
  (process.env.BACKUP_ENABLED !== 'false' && process.env.NODE_ENV !== 'test');
const intervalMs = readPositiveInt(process.env.BACKUP_INTERVAL_MS, 5 * 60_000);
const initialDelayMs = readPositiveInt(process.env.BACKUP_INITIAL_DELAY_MS, 10_000);

let records: BackupRecord[] = [];
let activeBackup: Promise<BackupRecord> | null = null;
let scheduleHandle: NodeJS.Timeout | null = null;
let nextScheduledAt: number | null = null;
let stopping = false;
let lastFailureAt: number | null = null;
let lastError: string | null = null;

export function backupStatus(): BackupStatus {
  return {
    enabled,
    inProgress: activeBackup !== null,
    intervalMs,
    nextScheduledAt,
    retainedCount: records.length,
    latest: records[0] || null,
    lastFailureAt,
    lastError,
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
  if (activeBackup) {
    try {
      await activeBackup;
    } catch {
      // The failure is already exposed through backupStatus().
    }
  }
}

export function createVerifiedBackup(reason = 'manual'): Promise<BackupRecord> {
  if (activeBackup) return activeBackup;
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

export function backupsToRetain(
  candidates: BackupRecord[],
  now = Date.now()
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
  return keep;
}

async function performBackup(reasonInput: string): Promise<BackupRecord> {
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  const reason = safeReason(reasonInput);
  const createdAt = Date.now();
  const hostSuffix = ensureReplicationIdentity().hostId.replace(/[^a-z0-9]/gi, '').slice(0, 8);
  const stamp = new Date(createdAt).toISOString().replace(/[-:.]/g, '');
  const fileName = `apolloon-${stamp}-${hostSuffix}-${reason}-${crypto.randomUUID().slice(0, 8)}.sqlite`;
  const finalPath = path.join(backupDirectory, fileName);
  const partialPath = `${finalPath}.partial`;
  let published = false;

  try {
    await backupDatabase(partialPath);
    verifyBackup(partialPath);
    await removeBackupSidecars(partialPath);
    await syncFile(partialPath);
    await fs.promises.rename(partialPath, finalPath);
    const [stat, sha256] = await Promise.all([
      fs.promises.stat(finalPath),
      hashFile(finalPath),
    ]);
    const record: BackupRecord = {
      fileName,
      createdAt,
      reason,
      sizeBytes: stat.size,
      sha256,
      verified: true,
    };
    await writeMetadata(record);
    records = [record, ...records.filter((item) => item.fileName !== fileName)]
      .sort((a, b) => b.createdAt - a.createdAt);
    published = true;
    await pruneBackups().catch((error) => {
      console.warn(
        'Old database backups could not be pruned:',
        error instanceof Error ? error.message : String(error)
      );
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
        const parsed = JSON.parse(
          fs.readFileSync(path.join(backupDirectory, entry), 'utf8')
        ) as Partial<BackupRecord>;
        if (
          typeof parsed.fileName !== 'string' ||
          !parsed.fileName.endsWith('.sqlite') ||
          !fs.existsSync(path.join(backupDirectory, parsed.fileName)) ||
          !Number.isSafeInteger(parsed.createdAt) ||
          typeof parsed.reason !== 'string' ||
          !Number.isSafeInteger(parsed.sizeBytes) ||
          fs.statSync(path.join(backupDirectory, parsed.fileName)).size !== parsed.sizeBytes ||
          typeof parsed.sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(parsed.sha256) ||
          parsed.verified !== true
        ) {
          return [];
        }
        return [{ ...parsed, verified: true } as BackupRecord];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function pruneBackups(): Promise<void> {
  const keep = backupsToRetain(records);
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
        console.warn(
          'Scheduled database backup failed:',
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => scheduleNext(intervalMs));
  }, delayMs);
  scheduleHandle.unref?.();
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
  await Promise.all([
    fs.promises.rm(filePath, { force: true }),
    removeBackupSidecars(filePath),
  ]);
}

function safeReason(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return cleaned.slice(0, 32) || 'manual';
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
