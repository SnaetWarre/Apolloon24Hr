import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { BackupRecord, BackupStatus } from '../shared/schemas.js';
import { backupDatabase, databaseFileBytes } from './db.js';
import { DATA_ROOT, readPositiveInt } from './env.js';

const backupDirectory = path.join(DATA_ROOT, 'backups');
const enabled =
  process.env.BACKUP_ENABLED === 'true' || (process.env.BACKUP_ENABLED !== 'false' && process.env.NODE_ENV !== 'test');
const intervalMs = readPositiveInt(process.env.BACKUP_INTERVAL_MS, 5 * 60_000);
const initialDelayMs = readPositiveInt(process.env.BACKUP_INITIAL_DELAY_MS, 10_000);
const minimumFreeBytes = readPositiveInt(process.env.BACKUP_MIN_FREE_BYTES, 2 * 1_024 ** 3);

/** Four hours of scheduled backups at the default interval. */
const KEEP_SCHEDULED = 48;
/** Manual backups and the safety copies taken before joining or resynchronizing. */
const KEEP_OTHER = 20;

const verifyWorkerUrl = new URL(
  `./backup-verify-worker${path.extname(fileURLToPath(import.meta.url))}`,
  import.meta.url
);

let records: BackupRecord[] = [];
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
let scheduleHandle: NodeJS.Timeout | null = null;
let nextScheduledAt: number | null = null;
let lastFailureAt: number | null = null;
let lastError: string | null = null;

export function backupStatus(): BackupStatus {
  const diskFreeBytes = freeDiskBytes();
  return {
    enabled,
    inProgress: pending > 0,
    intervalMs,
    nextScheduledAt,
    retainedCount: records.length,
    latest: records[0] ?? null,
    lastError,
    lastFailureAt,
    diskFreeBytes,
    minimumFreeBytes,
    diskLow: diskFreeBytes !== null && diskFreeBytes < minimumFreeBytes,
    databaseBytes: databaseFileBytes(),
  };
}

export function startBackupService(): void {
  refreshInventory();
  if (enabled && !scheduleHandle) scheduleNext(initialDelayMs);
}

export async function stopBackupService(): Promise<void> {
  if (scheduleHandle) clearTimeout(scheduleHandle);
  scheduleHandle = null;
  nextScheduledAt = null;
  await queue.catch(() => undefined);
}

/** Queues a backup behind any running one, so each captures the state at its own turn. */
export function createVerifiedBackup(reason = 'manual'): Promise<BackupRecord> {
  pending += 1;
  const backup = queue
    .catch(() => undefined)
    .then(() => performBackup(safeReason(reason)))
    .catch((error: unknown) => {
      lastFailureAt = Date.now();
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      pending -= 1;
    });
  queue = backup;
  return backup;
}

export function latestBackupPath(): { record: BackupRecord; path: string } | null {
  const record = records[0];
  if (!record) return null;
  const filePath = path.join(backupDirectory, record.fileName);
  return fs.existsSync(filePath) ? { record, path: filePath } : null;
}

/** Every kept backup, newest first. */
export function listBackups(): BackupRecord[] {
  return records.slice();
}

/** The file of a kept backup; only names from the list are accepted, so no path leaves the folder. */
export function backupFile(fileName: string): { record: BackupRecord; path: string } | null {
  const record = records.find((item) => item.fileName === fileName);
  if (!record) return null;
  const filePath = path.join(backupDirectory, record.fileName);
  return fs.existsSync(filePath) ? { record, path: filePath } : null;
}

/** Keeps the newest scheduled and the newest other backups; returns the file names to keep. */
export function backupsToRetain(candidates: BackupRecord[]): Set<string> {
  const newestFirst = candidates.slice().sort((a, b) => b.createdAt - a.createdAt);
  return new Set(
    [
      ...newestFirst.filter((record) => record.scheduled).slice(0, KEEP_SCHEDULED),
      ...newestFirst.filter((record) => !record.scheduled).slice(0, KEEP_OTHER),
    ].map((record) => record.fileName)
  );
}

async function performBackup(reason: string): Promise<BackupRecord> {
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const fileName = `apolloon-${stamp}-${reason}-${crypto.randomUUID().slice(0, 8)}.sqlite`;
  const finalPath = path.join(backupDirectory, fileName);
  const partialPath = `${finalPath}.partial`;
  try {
    await backupDatabase(partialPath);
    await verifyInWorker(partialPath);
    await syncFile(partialPath);
    await fs.promises.rename(partialPath, finalPath);
  } finally {
    await removeFiles(partialPath, `${partialPath}-wal`, `${partialPath}-shm`, `${partialPath}-journal`);
  }
  const record = recordFor(fileName);
  if (!record) throw new Error('De backup verdween meteen na het schrijven.');
  records = [record, ...records.filter((item) => item.fileName !== fileName)];
  await pruneBackups();
  lastError = null;
  return record;
}

function verifyInWorker(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(verifyWorkerUrl, { workerData: { filePath } });
    worker.once('message', (result: { ok: boolean; error?: string }) =>
      result.ok ? resolve() : reject(new Error(`Backupcontrole mislukt: ${result.error}`))
    );
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Backupcontrole stopte onverwacht (code ${code}).`));
    });
  });
}

function recordFor(fileName: string): BackupRecord | null {
  try {
    const stat = fs.statSync(path.join(backupDirectory, fileName));
    return {
      fileName,
      createdAt: Math.round(stat.mtimeMs),
      sizeBytes: stat.size,
      scheduled: /-scheduled-[0-9a-f]{8}\.sqlite$/.test(fileName),
    };
  } catch {
    return null;
  }
}

function refreshInventory(): void {
  fs.mkdirSync(backupDirectory, { recursive: true });
  const entries = fs.readdirSync(backupDirectory);
  for (const entry of entries) {
    // Unfinished copies, and the manifest files older versions wrote beside each backup.
    if (/\.partial(-wal|-shm|-journal)?$|\.sqlite\.json$/.test(entry)) {
      fs.rmSync(path.join(backupDirectory, entry), { force: true });
    }
  }
  records = entries
    .filter((entry) => entry.startsWith('apolloon-') && entry.endsWith('.sqlite'))
    .flatMap((entry) => recordFor(entry) ?? [])
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function pruneBackups(): Promise<void> {
  const keep = backupsToRetain(records);
  const removed = records.filter((record) => !keep.has(record.fileName));
  records = records.filter((record) => keep.has(record.fileName));
  await removeFiles(...removed.map((record) => path.join(backupDirectory, record.fileName)));
}

function scheduleNext(delayMs: number): void {
  nextScheduledAt = Date.now() + delayMs;
  scheduleHandle = setTimeout(() => {
    scheduleHandle = null;
    nextScheduledAt = null;
    void createVerifiedBackup('scheduled')
      .catch((error) => {
        console.warn('Scheduled database backup failed:', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (enabled) scheduleNext(intervalMs);
      });
  }, delayMs);
  scheduleHandle.unref();
}

async function syncFile(filePath: string): Promise<void> {
  // Windows only flushes a handle opened for writing (read-only fails with EPERM).
  const handle = await fs.promises.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeFiles(...filePaths: string[]): Promise<void> {
  await Promise.all(filePaths.map((filePath) => fs.promises.rm(filePath, { force: true })));
}

function safeReason(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, 32) || 'manual';
}

function freeDiskBytes(): number | null {
  try {
    const stats = fs.statfsSync(fs.existsSync(backupDirectory) ? backupDirectory : DATA_ROOT);
    return Math.max(0, Math.trunc(stats.bavail * stats.bsize));
  } catch {
    return null;
  }
}
