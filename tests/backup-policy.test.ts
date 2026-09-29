import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { BackupRecord } from '../shared/schemas.ts';

const dataPath = path.resolve(`.tmp-test-backups-${process.pid}`);
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

    const restored = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal(restored.pragma('journal_mode', { simple: true }), 'delete');
      assert.deepEqual(
        restored.prepare('SELECT name, runner_number AS runnerNumber FROM runners WHERE id = ?').get(runner.id),
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

test('retention keeps the newest scheduled and the newest other backups', async () => {
  const { backupsToRetain } = await import('../server/backups.ts');
  const record = (index: number, scheduled: boolean): BackupRecord => ({
    fileName: `${scheduled ? 'scheduled' : 'manual'}-${index}`,
    createdAt: index * 60_000,
    sizeBytes: 1_024,
    scheduled,
  });
  const candidates = [
    ...Array.from({ length: 60 }, (_, index) => record(index, true)),
    ...Array.from({ length: 25 }, (_, index) => record(index, false)),
  ];
  const keep = backupsToRetain(candidates);
  assert.equal(keep.size, 48 + 20);
  assert.ok(keep.has('scheduled-59') && !keep.has('scheduled-11'));
  assert.ok(keep.has('manual-24') && !keep.has('manual-4'));
});
