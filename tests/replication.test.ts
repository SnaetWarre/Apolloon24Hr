import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const dataPath = path.resolve(`.tmp-test-replication-${process.pid}`);
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

async function freshDatabase() {
  const db = await import('../server/db.ts');
  db.closeDb();
  fs.rmSync(dataPath, { recursive: true, force: true });
  await db.initDb();
  return db;
}

test('each committed write is logged once; reads and rolled-back writes are not', async () => {
  const db = await freshDatabase();
  const revisions: number[] = [];
  const stopListening = db.onAppDataChanged((revision) => revisions.push(revision));
  try {
    db.recordWrite('test.create', () => db.insertRunner({ name: 'Logged', runnerNumber: '1' }));
    assert.throws(
      () =>
        db.recordWrite('test.fail', () => {
          db.insertRunner({ name: 'Rolled back', runnerNumber: '2' });
          throw new Error('simulated failure');
        }),
      /simulated failure/
    );
    db.recordWrite('test.read', () => db.getAllRunners());

    assert.deepEqual(
      db.getAllRunners().map((runner) => runner.name),
      ['Logged']
    );
    assert.equal(db.getLogHead().seq, 1);
    assert.equal(db.getLogEntriesAfter(0)[0]?.type, 'test.create');
    assert.equal(revisions.length, 1, 'only the committed change notifies clients');
  } finally {
    stopListening();
    db.closeDb();
  }
});

test('replaying the log on another database reproduces the primary exactly', async () => {
  const db = await freshDatabase();
  const { appSnapshot } = await import('../server/app-state.ts');
  const write = <T>(action: () => T) => db.recordWrite('test.write', action);

  const blue = db.findLabelByName('Speedteam Blue')!;
  const alice = write(() => db.insertRunner({ name: 'Alice', runnerNumber: '1', labels: [blue.id, 'Nieuw label'] }));
  const bob = write(() => db.insertRunner({ name: 'Bob', runnerNumber: '2' }));
  write(() => db.updateRunnerStatus({ id: alice.id, status: 'waiting', statusSince: 1_000 }));
  write(() => db.updateRunnerStatus({ id: bob.id, status: 'waiting', statusSince: 1_100 }));
  write(() => db.performHandoff(2_000));
  write(() => db.performHandoff(70_000));
  write(() => db.undoLastHandoff());
  write(() => db.createBurgieGepaktEvent(71_000));
  write(() => {
    const team = db.createLabel({ name: 'Nachtploeg', kind: 'temporary_team', color: '#7c3aed' });
    db.setTemporaryTeamMembers(team.id, [bob.id]);
    db.setTemporaryTeamSchedule(team.id, 0, Date.now() + 3_600_000);
  });
  write(() => db.setPublicRecordMode('hour'));

  const comparable = () => {
    const { revision: _revision, host: _host, ...snapshot } = appSnapshot();
    return snapshot;
  };
  const expected = comparable();
  const entries = db.getLogEntriesAfter(0);
  assert.equal(entries.length, 10);

  db.closeDb();
  fs.rmSync(dataPath, { recursive: true, force: true });
  await db.initDb();
  db.applyLogEntries(entries);

  assert.deepEqual(comparable(), expected);
  assert.equal(db.getLogHead().id, entries.at(-1)?.id);
  assert.throws(() => db.applyLogEntries(entries.slice(0, 1)), /replication gap/);
  db.closeDb();
});

test('a standby can only continue from a retained prefix of the primary log', async () => {
  const db = await freshDatabase();
  const noop = { sql: 'UPDATE race_state SET race_finished_at = race_finished_at WHERE id = 1', params: [] };
  const entries = Array.from({ length: 5_500 }, (_, index) => ({
    seq: index + 1,
    id: `entry-${index + 1}`,
    epoch: 0,
    type: 'test.noop',
    statements: [noop],
    createdAt: index,
  }));

  db.applyLogEntries(entries.slice(0, 10));
  assert.equal(db.canContinueFrom(0, null), true);
  assert.equal(db.canContinueFrom(10, 'entry-10'), true);
  assert.equal(db.canContinueFrom(10, 'another-history'), false, 'a diverged standby must re-sync');
  assert.equal(db.canContinueFrom(11, 'entry-11'), false, 'a standby ahead of the primary must re-sync');

  db.applyLogEntries(entries.slice(10));
  assert.equal(db.canContinueFrom(5_500, 'entry-5500'), true);
  assert.equal(db.canContinueFrom(100, 'entry-100'), false, 'pruned entries force a full re-sync');
  assert.equal(db.canContinueFrom(0, null), false);
  assert.ok(db.getLogEntriesAfter(0)[0]!.seq > 1);
  db.closeDb();
});

test('installing a primary image replaces the event data but keeps this laptop identity', async () => {
  const db = await freshDatabase();
  const primary = db.hostIdentity();
  db.recordWrite('test.create', () => db.insertRunner({ name: 'From primary', runnerNumber: '1' }));
  const image = db.serializeDatabase();
  const imageHead = db.getLogHead();

  db.setLocalSetting('replication_cluster_id', 'another-cluster');
  db.setLocalSetting('host_id', 'standby-host');
  db.recordWrite('test.create', () => db.insertRunner({ name: 'Local only', runnerNumber: '2' }));
  db.recordWrite('test.create', () => db.insertRunner({ name: 'Local only too', runnerNumber: '3' }));

  const installed = db.installDatabaseImage(image, db.DATABASE_SCHEMA_VERSION);
  assert.equal(installed.clusterId, primary.clusterId);
  assert.deepEqual(db.hostIdentity(), { hostId: 'standby-host', clusterId: primary.clusterId });
  assert.deepEqual(
    db.getAllRunners().map((runner) => runner.name),
    ['From primary']
  );
  assert.deepEqual(db.getLogHead(), imageHead);
  assert.throws(() => db.installDatabaseImage(image, db.DATABASE_SCHEMA_VERSION + 1), /schema/);
  db.closeDb();
  fs.rmSync(dataPath, { recursive: true, force: true });
});
