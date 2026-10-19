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

test('clearing the race after a test run keeps runners and labels, and a backup of the race', async () => {
  const db = await import('../server/db.ts');
  const backups = await import('../server/backups.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'Test runner', runnerNumber: '901' });
    const second = db.insertRunner({ name: 'Other runner', runnerNumber: '902' });
    db.updateRunnerStatus({ id: first.id, status: 'waiting', statusSince: 900, queueIndex: 0 });
    db.updateRunnerStatus({ id: second.id, status: 'waiting', statusSince: 900, queueIndex: 1 });
    db.performHandoff(1_000);
    db.performHandoff(80_000);
    db.createBurgieGepaktEvent(81_000);
    const labelCount = db.getLabels().length;

    const caller = appRouter.createCaller({ forwarded: true, requestId: 'clear-race', origin: 'test' });
    const result = await caller.race.clear();
    assert.equal(result.laps, 1);
    assert.ok(backups.listBackups().some((record) => record.fileName === result.safetyBackup));
    assert.deepEqual(db.raceProgress(), { raceStarted: false, raceRunning: false });
    assert.equal(db.getRaceState().activeRunnerId, null);
    assert.equal(db.getRecentRaceEvents(10).length, 0);
    for (const runner of [first, second]) {
      const after = db.getRunnerById(runner.id);
      assert.equal(after?.status, 'registered');
      assert.equal(after?.queueIndex, null);
    }
    assert.equal(db.getLabels().length, labelCount);
    assert.match(db.getActivity(1)[0]?.summary ?? '', /Race gewist na de testrun \(1 rondes\)/);
  } finally {
    db.closeDb();
  }
});

test('Alles wissen also removes the runners, keeps the labels, and keeps a backup', async () => {
  const db = await import('../server/db.ts');
  const backups = await import('../server/backups.ts');
  const { appRouter } = await import('../server/router.ts');
  try {
    await db.initDb();
    const first = db.insertRunner({ name: 'Wis runner', runnerNumber: '911', labels: ['HILOK'] });
    const second = db.insertRunner({ name: 'Wis other', runnerNumber: '912' });
    db.updateRunnerStatus({ id: first.id, status: 'waiting', statusSince: 900, queueIndex: 0 });
    db.updateRunnerStatus({ id: second.id, status: 'waiting', statusSince: 900, queueIndex: 1 });
    db.performHandoff(1_000);
    db.performHandoff(80_000);
    const labelCount = db.getLabels().length;
    const runnerCount = db.getAllRunners().length;

    const caller = appRouter.createCaller({ forwarded: true, requestId: 'clear-everything', origin: 'test' });
    const result = await caller.race.clear({ runners: true });
    assert.equal(result.laps, 1);
    assert.equal(result.runners, runnerCount);
    assert.ok(backups.listBackups().some((record) => record.fileName === result.safetyBackup));
    assert.equal(db.getAllRunners().length, 0);
    assert.deepEqual(db.raceProgress(), { raceStarted: false, raceRunning: false });
    assert.equal(db.getLabels().length, labelCount);
    assert.match(db.getActivity(1)[0]?.summary ?? '', /Alles gewist: race en lopers \(1 rondes, \d+ lopers\)/);
  } finally {
    db.closeDb();
  }
});
