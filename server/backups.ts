import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { BackupRecord, BackupStatus } from '../shared/schemas.js';
import { backupDatabase, damagedDatabase, databaseFileBytes } from './db.js';
import { DATA_ROOT, readPositiveInt } from './env.js';

const backupDirectory = path.join(DATA_ROOT, 'backups');
const enabled =
  process.env.BACKUP_ENABLED === 'true' || (process.env.BACKUP_ENABLED !== 'false' && process.env.NODE_ENV !== 'test');
const intervalMs = readPositiveInt(process.env.BACKUP_INTERVAL_MS, 5 * 60_000);
const initialDelayMs = readPositiveInt(process.env.BACKUP_INITIAL_DELAY_MS, 10_000);
const minimumFreeBytes = readPositiveInt(process.env.BACKUP_MIN_FREE_BYTES, 2 * 1_024 ** 3);

/** Four hours of scheduled backups at the default interval. */
const KEEP_SCHEDULED = 48;
/** Beyond those, the newest scheduled backup of each clock hour, so a whole race can be rolled back. */
const KEEP_HOURLY_MS = 30 * 60 * 60_000;
/** Backups an operator made; kept apart so automatic copies never push them out. */
const KEEP_MANUAL = 20;
/** The safety copies taken before joining, resynchronizing or restoring. */
const KEEP_SAFETY = 20;

const verifyWorkerUrl = new URL(
  `./backup-verify-worker${path.extname(fileURLToPath(import.meta.url))}`,
  import.meta.url
);

let records: BackupRecord[] = [];
let queue: Promise<unknown> = Promise.resolve();
let pending = 0;
/** Set when a backup fails, cleared when a later one succeeds. */
let lastFailure: { at: number; error: string } | null = null;

type SchedulerState =
  | { name: 'stopped' }
  | { name: 'waiting'; at: number; timer: NodeJS.Timeout }
  | { name: 'running' };
type SchedulerEvent = 'start' | 'due' | 'finished' | 'stop';

/** The state each event leads to. An event missing from a state's row changes nothing. */
const SCHEDULER_MOVES: Record<SchedulerState['name'], Partial<Record<SchedulerEvent, SchedulerState['name']>>> = {
  stopped: { start: 'waiting' },
  waiting: { due: 'running', stop: 'stopped' },
  running: { finished: 'waiting', stop: 'stopped' },
};

let scheduler: SchedulerState = { name: 'stopped' };

export function backupStatus(): BackupStatus {
  const diskFreeBytes = freeDiskBytes();
  return {
    enabled,
    inProgress: pending > 0,
    intervalMs,
    nextScheduledAt: scheduler.name === 'waiting' ? scheduler.at : null,
    retainedCount: records.length,
    latest: records[0] ?? null,
    lastError: lastFailure?.error ?? null,
    lastFailureAt: lastFailure?.at ?? null,
    diskFreeBytes,
    minimumFreeBytes,
    diskLow: diskFreeBytes !== null && diskFreeBytes < minimumFreeBytes,
    databaseBytes: databaseFileBytes(),
    damagedDatabase: damagedDatabase(),
  };
}

export function startBackupService(): void {
  refreshInventory();
  if (enabled) moveScheduler('start');
}

export async function stopBackupService(): Promise<void> {
  moveScheduler('stop');
  await queue.catch(() => undefined);
}

/** Queues a backup behind any running one, so each captures the state at its own turn. */
export function createVerifiedBackup(reason = 'manual'): Promise<BackupRecord> {
  pending += 1;
  const backup = queue
    .catch(() => undefined)
    .then(() => performBackup(safeReason(reason)))
    .catch((error: unknown) => {
      lastFailure = { at: Date.now(), error: error instanceof Error ? error.message : String(error) };
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

/** Keeps the newest backups of each kind plus one scheduled backup per hour; returns the file names to keep. */
export function backupsToRetain(candidates: BackupRecord[]): Set<string> {
  const newestFirst = candidates.slice().sort((a, b) => b.createdAt - a.createdAt);
  const scheduled = newestFirst.filter((record) => record.scheduled);
  const manual = newestFirst.filter((record) => !record.scheduled && isManual(record.fileName));
  const safety = newestFirst.filter((record) => !record.scheduled && !isManual(record.fileName));
  const hourlySince = (newestFirst[0]?.createdAt ?? 0) - KEEP_HOURLY_MS;
  const hourly = new Map<number, BackupRecord>();
  for (const record of scheduled) {
    const hour = Math.floor(record.createdAt / 3_600_000);
    if (record.createdAt > hourlySince && !hourly.has(hour)) hourly.set(hour, record);
  }
  return new Set(
    [
      ...scheduled.slice(0, KEEP_SCHEDULED),
      ...hourly.values(),
      ...manual.slice(0, KEEP_MANUAL),
      ...safety.slice(0, KEEP_SAFETY),
    ].map((record) => record.fileName)
  );
}

function isManual(fileName: string): boolean {
  return /-manual-[0-9a-f]{8}\.sqlite$/.test(fileName);
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
  lastFailure = null;
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

/** The only place the scheduler changes state, so a backup that ends after a stop schedules nothing. */
function moveScheduler(event: SchedulerEvent): void {
  const next = SCHEDULER_MOVES[scheduler.name][event];
  if (!next) return;
  if (scheduler.name === 'waiting') clearTimeout(scheduler.timer);
  if (next === 'waiting') {
    const delayMs = event === 'start' ? initialDelayMs : intervalMs;
    const timer = setTimeout(() => moveScheduler('due'), delayMs);
    timer.unref();
    scheduler = { name: 'waiting', at: Date.now() + delayMs, timer };
    return;
  }
  const state: SchedulerState = { name: next };
  scheduler = state;
  if (next === 'running') {
    void createVerifiedBackup('scheduled')
      .catch((error) => {
        console.warn('Scheduled database backup failed:', error instanceof Error ? error.message : String(error));
      })
      // Only this run may finish it: after a stop and start, a newer run owns the scheduler.
      .finally(() => {
        if (scheduler === state) moveScheduler('finished');
      });
  }
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
