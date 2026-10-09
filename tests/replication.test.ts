import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('replication');
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
    assert.equal(db.getLogEntriesAfter(0)![0]?.type, 'test.create');
    assert.equal(revisions.length, 1, 'only the committed change notifies clients');
  } finally {
    stopListening();
    db.closeDb();
  }
});

test('a laptop counts as changed after an event write, not after linking with another laptop', async () => {
  const db = await freshDatabase();
  try {
    assert.equal(db.hasEventChanges(), false, 'default labels are seeded outside the log');
    db.recordWrite('cluster.addMember', () =>
      db.saveClusterMember({ hostId: 'other', url: 'http://10.0.0.2:3000', name: 'LAPTOP-2' })
    );
    assert.equal(db.hasEventChanges(), false, 'linking is bookkeeping, not a change to the event');
    db.recordWrite('labels.create', () => db.createLabel({ name: 'Trojan Horse', kind: 'temporary_team' }));
    assert.equal(db.hasEventChanges(), true);
  } finally {
    db.closeDb();
  }
});

test('replaying the log on another database reproduces the leader exactly', async () => {
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
  const entries = db.getLogEntriesAfter(0)!;
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

test('a follower can only continue from a retained prefix of the leader log', async () => {
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
  assert.equal(db.canContinueFrom(10, 'another-history'), false, 'a diverged follower must re-sync');
  assert.equal(db.canContinueFrom(11, 'entry-11'), false, 'a follower ahead of the leader must re-sync');

  db.applyLogEntries(entries.slice(10));
  assert.equal(db.canContinueFrom(5_500, 'entry-5500'), true);
  assert.equal(db.canContinueFrom(100, 'entry-100'), false, 'pruned entries force a full re-sync');
  assert.equal(db.canContinueFrom(0, null), false);
  assert.ok(db.getLogEntriesAfter(0)![0]!.seq > 1);
  db.closeDb();
});

test('a batch for a lagging laptop fits in one message; an entry too large for one is not sent', async () => {
  const db = await freshDatabase();
  const { MAX_BATCH_BYTES, MAX_ENTRY_BYTES } = await import('../server/db/replication.ts');
  const entry = (seq: number, bytes: number) => ({
    seq,
    id: `entry-${seq}`,
    epoch: 0,
    type: 'labels.uploadImage',
    statements: [
      {
        sql: 'UPDATE race_state SET race_finished_at = race_finished_at WHERE id = 1 AND ? IS NOT NULL',
        params: ['A'.repeat(bytes)],
      },
    ],
    createdAt: seq,
  });
  // Logos of about 1 MB each, like the uploads a laptop that was off misses.
  db.applyLogEntries(Array.from({ length: 25 }, (_, index) => entry(index + 1, 1_000_000)));

  const sent: number[] = [];
  for (let after = 0; after < 25;) {
    const batch = db.getLogEntriesAfter(after)!;
    assert.ok(batch.length >= 1);
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= MAX_BATCH_BYTES);
    assert.equal(batch[0]!.seq, after + 1);
    sent.push(batch.length);
    after = batch.at(-1)!.seq;
  }
  assert.ok(sent.length > 1, 'the missing logos must not travel in one message');

  // An entry over the budget still travels, on its own.
  db.applyLogEntries([entry(26, MAX_BATCH_BYTES + 1_000), entry(27, 10)]);
  assert.deepEqual(
    db.getLogEntriesAfter(25)!.map(({ seq }) => seq),
    [26]
  );
  assert.deepEqual(
    db.getLogEntriesAfter(26)!.map(({ seq }) => seq),
    [27]
  );

  // One too large for any message: the laptop that needs it takes a full copy instead.
  db.applyLogEntries([entry(28, MAX_ENTRY_BYTES)]);
  assert.equal(db.getLogEntriesAfter(27), null);
  assert.deepEqual(
    db.getLogEntriesAfter(26)!.map(({ seq }) => seq),
    [27]
  );
  db.closeDb();
});

test('a follower stores what continues its log and reports a gap or a different history', async () => {
  const db = await freshDatabase();
  const noop = { sql: 'UPDATE race_state SET race_finished_at = race_finished_at WHERE id = 1', params: [] };
  const entry = (seq: number, id = `entry-${seq}`) => ({
    seq,
    id,
    epoch: 1,
    type: 'test.noop',
    statements: [noop],
    createdAt: seq,
  });

  assert.deepEqual(db.appendFromLeader(0, null, [entry(1), entry(2)]), { ok: true });
  assert.deepEqual(db.appendFromLeader(3, 'entry-3', [entry(4)]), { ok: false, reason: 'behind' });
  // A repeat of entries it already has is harmless, so a lost answer can simply be sent again.
  assert.deepEqual(db.appendFromLeader(0, null, [entry(1), entry(2), entry(3)]), { ok: true });
  assert.equal(db.getLogHead().seq, 3);
  assert.deepEqual(db.appendFromLeader(3, 'entry-3', []), { ok: true }, 'a heartbeat');

  assert.deepEqual(db.appendFromLeader(2, 'other-2', [entry(3)]), { ok: false, reason: 'diverged' });
  assert.deepEqual(db.appendFromLeader(2, 'entry-2', [entry(3, 'other-3')]), { ok: false, reason: 'diverged' });
  assert.deepEqual(
    db.appendFromLeader(2, 'entry-2', []),
    { ok: false, reason: 'diverged' },
    'entries the leader does not have came from an earlier leader'
  );
  assert.equal(db.getLogHead().seq, 3, 'nothing is applied from a different history');
  db.closeDb();
});

test('installing a leader image replaces the event data and the removed laptops but keeps this laptop identity', async () => {
  const db = await freshDatabase();
  const leader = db.hostIdentity();
  db.recordWrite('test.create', () => db.insertRunner({ name: 'From leader', runnerNumber: '1' }));
  db.recordWrite('cluster.removeMember', () => db.setRemovedMembers(['broken-laptop']));
  const image = db.serializeDatabase();
  const imageHead = db.getLogHead();

  db.setLocalSetting('replication_cluster_id', 'another-cluster');
  db.setLocalSetting('host_id', 'follower-host');
  db.recordWrite('test.create', () => db.insertRunner({ name: 'Local only', runnerNumber: '2' }));
  db.recordWrite('test.create', () => db.insertRunner({ name: 'Local only too', runnerNumber: '3' }));
  db.recordWrite('cluster.removeMember', () => db.setRemovedMembers(['stale-laptop']));

  const installed = db.installDatabaseImage(image, db.DATABASE_SCHEMA_VERSION);
  assert.equal(installed.clusterId, leader.clusterId);
  assert.deepEqual(db.hostIdentity(), { hostId: 'follower-host', clusterId: leader.clusterId });
  assert.deepEqual(
    db.getAllRunners().map((runner) => runner.name),
    ['From leader']
  );
  assert.deepEqual(db.getLogHead(), imageHead);
  // A laptop taken out of the group before this one joined stays out when this one leads.
  assert.deepEqual(db.getRemovedMembers(), ['broken-laptop']);
  assert.throws(() => db.installDatabaseImage(image, db.DATABASE_SCHEMA_VERSION + 1), /schema/);

  // The right schema version on an outdated runners table is refused too.
  const outdatedPath = path.join(dataPath, 'outdated.sqlite');
  fs.writeFileSync(outdatedPath, image);
  const outdated = new DatabaseSync(outdatedPath);
  outdated.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE runners;
    CREATE TABLE runners (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, registration_json TEXT);
  `);
  outdated.close();
  assert.throws(
    () => db.installDatabaseImage(fs.readFileSync(outdatedPath), db.DATABASE_SCHEMA_VERSION),
    /runners: column runner_number is missing/
  );
  assert.deepEqual(
    db.getAllRunners().map((runner) => runner.name),
    ['From leader']
  );
  db.closeDb();
  fs.rmSync(dataPath, { recursive: true, force: true });
});
