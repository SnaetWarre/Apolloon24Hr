import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { BackupRecord } from '../shared/schemas.ts';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('backups');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';
process.env.BACKUP_ENABLED = 'false';

test('online backups are verified off the main thread and restorable as single SQLite files', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const backups = await import('../server/backups.ts');
  try {
    await db.initDb();
    backups.startBackupService();
    const runner = db.recordWrite('test.create', () =>
      db.insertRunner({ name: 'Backup runner', runnerNumber: 'BACKUP-1' })
    );

    const record = await backups.createVerifiedBackup('manual');
    const backupPath = path.join(dataPath, 'backups', record.fileName);
    assert.deepEqual(fs.readdirSync(path.dirname(backupPath)), [record.fileName], 'no partial or sidecar files');
    assert.equal(record.scheduled, false);

    const restored = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.deepEqual({ ...restored.prepare('PRAGMA journal_mode').get() }, { journal_mode: 'delete' });
      assert.deepEqual(
        { ...restored.prepare('SELECT name, runner_number AS runnerNumber FROM runners WHERE id = ?').get(runner.id) },
        {
          name: 'Backup runner',
          runnerNumber: 'BACKUP-1',
        }
      );
    } finally {
      restored.close();
    }

    const [scheduled, manual] = await Promise.all([
      backups.createVerifiedBackup('scheduled'),
      backups.createVerifiedBackup('manual'),
    ]);
    assert.equal(scheduled.scheduled, true);
    assert.notEqual(scheduled.fileName, manual.fileName);
    const status = backups.backupStatus();
    assert.equal(status.retainedCount, 3);
    assert.equal(status.inProgress, false);
    assert.equal(backups.latestBackupPath()?.record.fileName, status.latest?.fileName);
    assert.ok((status.diskFreeBytes ?? 0) > 0);
    assert.ok(status.databaseBytes > 0);
  } finally {
    await backups.stopBackupService();
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

const backupRecord = (reason: string, index: number, createdAt: number): BackupRecord => ({
  fileName: `apolloon-${createdAt}-${reason}-${index.toString(16).padStart(8, '0')}.sqlite`,
  createdAt,
  sizeBytes: 1_024,
  scheduled: reason === 'scheduled',
});

test('retention keeps the newest scheduled, manual and safety backups', async () => {
  const { backupsToRetain } = await import('../server/backups.ts');
  const candidates = [
    ...Array.from({ length: 60 }, (_, index) => backupRecord('scheduled', index, index * 60_000)),
    ...Array.from({ length: 25 }, (_, index) => backupRecord('manual', index, index * 60_000)),
    ...Array.from({ length: 25 }, (_, index) => backupRecord('pre-join', index, index * 60_000)),
  ];
  const keep = backupsToRetain(candidates);
  const kept = (reason: string, index: number) => keep.has(backupRecord(reason, index, index * 60_000).fileName);
  assert.equal(keep.size, 48 + 20 + 20);
  assert.ok(kept('scheduled', 59) && !kept('scheduled', 11));
  assert.ok(kept('manual', 24) && !kept('manual', 4));
  assert.ok(kept('pre-join', 24) && !kept('pre-join', 4));
});

test('retention keeps one scheduled backup per hour across a 24-hour race', async () => {
  const { backupsToRetain } = await import('../server/backups.ts');
  const interval = 5 * 60_000;
  const candidates = Array.from({ length: 24 * 12 }, (_, index) => backupRecord('scheduled', index, index * interval));
  const keep = backupsToRetain(candidates);
  const kept = candidates.filter((record) => keep.has(record.fileName));
  // The newest 48 cover hours 20-23; hours 0-19 each keep their last backup.
  assert.equal(kept.length, 48 + 20);
  assert.deepEqual(
    kept.slice(0, 20),
    Array.from({ length: 20 }, (_, hour) => candidates[hour * 12 + 11])
  );
  assert.deepEqual(kept.slice(20), candidates.slice(-48));
});

test('retention drops hourly backups older than 30 hours', async () => {
  const { backupsToRetain } = await import('../server/backups.ts');
  const candidates = Array.from({ length: 40 * 12 }, (_, index) =>
    backupRecord('scheduled', index, index * 5 * 60_000)
  );
  const keep = backupsToRetain(candidates);
  // The newest is at 39:55; hours 10-35 keep one each, hour 9 ends exactly 30 hours earlier.
  assert.equal(keep.size, 48 + 26);
  assert.ok(keep.has(candidates[10 * 12 + 11].fileName) && !keep.has(candidates[9 * 12 + 11].fileName));
});

test('safety copies never push out a manual backup', async () => {
  const { backupsToRetain } = await import('../server/backups.ts');
  const manual = backupRecord('manual', 0, 0);
  const resyncs = Array.from({ length: 30 }, (_, index) => backupRecord('pre-resync', index, (index + 1) * 60_000));
  const keep = backupsToRetain([manual, ...resyncs]);
  assert.ok(keep.has(manual.fileName));
  assert.equal(keep.size, 1 + 20);
  assert.ok(keep.has(resyncs[29].fileName) && !keep.has(resyncs[9].fileName));
});
