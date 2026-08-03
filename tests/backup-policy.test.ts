import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const dataPath = path.resolve(`.tmp-test-backups-${process.pid}`);
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';
process.env.BACKUP_ENABLED = 'false';

test('online backups are verified, checksummed, and readable as independent SQLite files', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const backups = await import('../server/backups.ts');
  try {
    await db.initDb();
    const runner = db.commitReplicatedWrite({
      id: crypto.randomUUID(),
      type: 'test.backup-runner',
      payload: { name: 'Backup runner' },
      action: () =>
        db.insertRunner({
          name: 'Backup runner',
          runnerNumber: 'BACKUP-1',
        }),
    });

    const record = await backups.createVerifiedBackup('manual');
    const backupPath = path.join(dataPath, 'backups', record.fileName);
    assert.equal(fs.existsSync(backupPath), true);
    assert.equal(fs.existsSync(`${backupPath}.json`), true);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex'),
      record.sha256
    );

    const restored = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      const stored = restored
        .prepare('SELECT name, runner_number AS runnerNumber FROM runners WHERE id = ?')
        .get(runner.id) as { name: string; runnerNumber: string } | undefined;
      assert.deepEqual(stored, { name: 'Backup runner', runnerNumber: 'BACKUP-1' });
      assert.equal(restored.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      restored.close();
    }

    const status = backups.backupStatus();
    assert.equal(status.latest?.fileName, record.fileName);
    assert.equal(status.latest?.verified, true);
    assert.equal(status.retainedCount, 1);
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('retention keeps recent, hourly, daily, and bounded manual recovery points', async () => {
  const { backupsToRetain } = await import('../server/backups.ts');
  const now = Date.UTC(2026, 7, 3, 20, 0, 0);
  const record = (name: string, createdAt: number, reason = 'scheduled') => ({
    fileName: `${name}.sqlite`,
    createdAt,
    reason,
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    verified: true as const,
  });
  const candidates = [
    ...Array.from({ length: 36 }, (_, index) =>
      record(`recent-${index}`, now - index * 5 * 60_000)
    ),
    ...Array.from({ length: 80 }, (_, index) =>
      record(`hourly-${index}`, now - (index + 4) * 60 * 60_000)
    ),
    ...Array.from({ length: 35 }, (_, index) =>
      record(`daily-${index}`, now - (index + 4) * 24 * 60 * 60_000)
    ),
    ...Array.from({ length: 25 }, (_, index) =>
      record(`manual-${index}`, now - index * 1_000, 'manual')
    ),
  ];

  const keep = backupsToRetain(candidates, now);
  assert.equal([...keep].filter((name) => name.startsWith('manual-')).length, 20);
  assert.equal(keep.has('recent-0.sqlite'), true);
  assert.equal(keep.has('recent-23.sqlite'), true);
  assert.equal(keep.has('daily-34.sqlite'), false);
  assert.ok(keep.size < candidates.length);
  assert.ok(keep.size <= 146);
});
