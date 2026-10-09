import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('restore');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';
process.env.CLUSTER_ENABLED = 'false';

test('restore returns missing settings to their defaults and keeps host-local settings and the group', async () => {
  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    const identity = db.hostIdentity();
    const backupPath = path.join(dataPath, 'default.sqlite');
    await db.backupDatabase(backupPath);
    const data = db.readRestoreData(backupPath, 'apolloon-default.sqlite', Date.now());
    assert.deepEqual(data.settings, []);
    db.recordWrite('settings.updatePublicRecordMode', () => db.setPublicRecordMode('off'));
    db.recordWrite('cluster.removeMember', () => db.setRemovedMembers(['broken-laptop']));
    db.recordWrite('backups.applyRestore', () => db.replaceEventData(data));
    assert.equal(db.getAppSettings().publicRecordMode, 'day');
    // A backup holds race data, not the group: a laptop taken out stays out.
    assert.deepEqual(db.getRemovedMembers(), ['broken-laptop']);
    assert.deepEqual(db.hostIdentity(), identity);
    assert.ok(
      db
        .getLogEntriesAfter(0)!
        .at(-1)
        ?.statements.some((statement) => statement.sql === 'DELETE FROM settings WHERE key = ?'),
      'the setting reset must also reach the other laptops'
    );
  } finally {
    db.closeDb();
  }
});

test('repeating a forwarded restore returns the same result without another safety backup', async () => {
  const db = await import('../server/db.ts');
  const backups = await import('../server/backups.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const backupPath = path.join(dataPath, 'repeat.sqlite');
    await db.backupDatabase(backupPath);
    const data = db.readRestoreData(backupPath, 'apolloon-repeat.sqlite', Date.now());
    const caller = appRouter.createCaller({ forwarded: true, requestId: 'restore-repeat', origin: 'test' });
    const restored = await caller.backups.applyRestore(data);
    const count = backups.listBackups().length;
    assert.ok(backups.listBackups().some((record) => record.fileName === restored.safetyBackup));
    assert.deepEqual(await caller.backups.applyRestore(data), restored);
    assert.equal(backups.listBackups().length, count);
  } finally {
    db.closeDb();
  }
});
