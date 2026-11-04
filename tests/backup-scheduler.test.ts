import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { temporaryDataPath } from './temporary-data.ts';

// Registered before the data folder exists, so the database closes before the folder is removed:
// Windows refuses to delete a folder that holds an open file, and `after` hooks run in order.
after(async () => {
  await backups.stopBackupService();
  db.closeDb();
});
const dataPath = temporaryDataPath('backup-scheduler');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';
process.env.CLUSTER_ENABLED = 'false';
process.env.BACKUP_ENABLED = 'true';
process.env.BACKUP_INITIAL_DELAY_MS = '1';
process.env.BACKUP_INTERVAL_MS = '400';

const db = await import('../server/db.ts');
const backups = await import('../server/backups.ts');
const backupDirectory = path.join(dataPath, 'backups');

before(() => db.initDb());

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`);
    await sleep(1);
  }
}

const scheduledFiles = () => fs.readdirSync(backupDirectory).filter((name) => name.includes('-scheduled-'));
const running = () => backups.backupStatus().inProgress && backups.backupStatus().nextScheduledAt === null;
const waiting = () => !backups.backupStatus().inProgress && backups.backupStatus().nextScheduledAt !== null;

test('the scheduler waits, runs a backup, waits again and stops', async () => {
  assert.equal(backups.backupStatus().nextScheduledAt, null, 'stopped before start');
  backups.startBackupService();
  assert.ok(backups.backupStatus().nextScheduledAt, 'start: stopped to waiting');
  await until(running, 'the first scheduled backup runs');
  await until(() => scheduledFiles().length === 1 && waiting(), 'the scheduler waits for the next one');
  const next = backups.backupStatus().nextScheduledAt!;
  assert.ok(next > Date.now() + 100, 'the next backup waits a whole interval');
  backups.startBackupService();
  assert.equal(backups.backupStatus().nextScheduledAt, next, 'a second start changes nothing');
  await backups.stopBackupService();
  assert.equal(backups.backupStatus().nextScheduledAt, null, 'stop: waiting to stopped');
  await sleep(500);
  assert.equal(scheduledFiles().length, 1, 'no backup after the stop');
});

test('a backup that is still running when the service stops schedules nothing after it', async () => {
  const before = scheduledFiles().length;
  backups.startBackupService();
  await until(running, 'a scheduled backup runs');
  await backups.stopBackupService();
  assert.equal(scheduledFiles().length, before + 1, 'the running backup finished');
  assert.equal(backups.backupStatus().nextScheduledAt, null, 'stop: running to stopped');
  await sleep(500);
  assert.equal(backups.backupStatus().nextScheduledAt, null);
  assert.equal(scheduledFiles().length, before + 1, 'no backup after the stop');
});

test('a successful backup ends the failure a previous one left', async () => {
  fs.rmSync(backupDirectory, { recursive: true, force: true });
  fs.writeFileSync(backupDirectory, 'not a folder');
  await assert.rejects(backups.createVerifiedBackup('manual'));
  const failed = backups.backupStatus();
  assert.ok(failed.lastError);
  assert.ok(failed.lastFailureAt);

  fs.rmSync(backupDirectory);
  await backups.createVerifiedBackup('manual');
  const recovered = backups.backupStatus();
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.lastFailureAt, null);
});
