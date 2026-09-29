import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const dataPath = path.resolve(`.tmp-test-schema-migration-${process.pid}`);
const databasePath = path.join(dataPath, 'data', 'app.db');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

/** The tables of a schema 12 database: multi-master replication and rewritten night-team labels. */
const LEGACY_SCHEMA = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE runners (
    id TEXT PRIMARY KEY, runner_number TEXT UNIQUE, name TEXT NOT NULL, target_laps INTEGER,
    historical_avg_ms INTEGER, historical_best_ms INTEGER,
    registration_source TEXT NOT NULL DEFAULT 'manual' CHECK(registration_source IN ('import','manual')),
    notes TEXT DEFAULT '', registration_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE labels (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, icon TEXT NOT NULL, kind TEXT NOT NULL,
    image_url TEXT, target_laps INTEGER, sort_order INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE runner_labels (runner_id TEXT NOT NULL, label_id TEXT NOT NULL, PRIMARY KEY (runner_id, label_id));
  CREATE TABLE queue_entries (
    runner_id TEXT PRIMARY KEY, status TEXT NOT NULL, queue_index INTEGER, status_since INTEGER, hidden_at INTEGER
  );
  CREATE TABLE temporary_teams (
    label_id TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 0, activated_at INTEGER,
    starts_at INTEGER, ends_at INTEGER, schedule_owner_host_id TEXT
  );
  CREATE TABLE temporary_team_members (
    team_label_id TEXT NOT NULL, runner_id TEXT NOT NULL UNIQUE, restore_label_ids_json TEXT,
    PRIMARY KEY (team_label_id, runner_id)
  );
  CREATE TABLE replication_operations (id TEXT PRIMARY KEY, statements_json TEXT NOT NULL);
  CREATE TABLE replication_peer_progress (peer_host_id TEXT NOT NULL, origin_host_id TEXT NOT NULL);
  CREATE TABLE replication_conflicts (id TEXT PRIMARY KEY);

  INSERT INTO settings VALUES
    ('schema_version', '12'), ('host_id', 'legacy-host'), ('replication_cluster_id', 'legacy-cluster'),
    ('replication_cluster_secret', 'secret'), ('replication_hlc_wall_ms', '1'), ('replication_hlc_counter', '0'),
    ('replication_checkpoint_gzip_v1', 'gzip-base64-v1:AAAA'), ('timing_controller_host_id', 'legacy-host'),
    ('timing_controller_generation', '3'), ('last_database_compaction_at', '1'), ('public_record_mode', 'hour');
  INSERT INTO labels VALUES
    ('blue', 'Speedteam Blue', '#1d4ed8', 'SB', 'speedteam', NULL, NULL, 20, 1, 1),
    ('night', 'Nachtploeg', '#7c3aed', 'NP', 'temporary_team', NULL, NULL, 25, 1, 1);
  INSERT INTO runners (id, runner_number, name, created_at, updated_at) VALUES
    ('alice', '1', 'Alice', 1, 1), ('bob', '2', 'Bob', 1, 1), ('cleo', '3', 'Cleo', 1, 1);
  INSERT INTO queue_entries VALUES ('alice', 'waiting', 0, 700, NULL), ('bob', 'ran', NULL, 800, 900);
  -- An active night team had swapped Alice's speedteam for its own label.
  INSERT INTO runner_labels VALUES ('alice', 'night');
  INSERT INTO temporary_teams VALUES ('night', 1, 500, 0, 4102444800000, 'legacy-host');
  INSERT INTO temporary_team_members VALUES ('night', 'alice', '["blue"]');
  INSERT INTO replication_operations VALUES ('op-1', '[]');
`;

test('schema 13 retires multi-master replication, moves the queue onto runners, and derives night-team labels', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const legacy = new Database(databasePath);
  legacy.exec(LEGACY_SCHEMA);
  legacy.close();

  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    assert.ok(fs.existsSync(path.join(dataPath, 'data', 'app.pre-schema-13.sqlite')), 'keeps a pre-migration copy');
    assert.deepEqual(db.hostIdentity(), { hostId: 'legacy-host', clusterId: 'legacy-cluster' });
    assert.equal(db.getAppSettings().publicRecordMode, 'hour');

    // Alice runs for the night team while it is active, and is back in Blue in the stored labels.
    assert.deepEqual(
      db.getRunnerById('alice')?.labels.map((label) => label.id),
      ['night']
    );
    assert.deepEqual(
      db.getTemporaryTeams().map((team) => [team.labelId, team.active]),
      [['night', true]]
    );
    const queue = Object.fromEntries(
      db
        .getAllRunners()
        .map((runner) => [runner.id, [runner.status, runner.queueIndex, runner.statusSince, runner.hiddenFromQueue]])
    );
    assert.deepEqual(queue, {
      alice: ['waiting', 0, 700, false],
      bob: ['ran', null, 800, true],
      cleo: ['registered', null, null, false],
    });

    db.closeDb();
    const migrated = new Database(databasePath, { readonly: true });
    try {
      const tables = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
      assert.ok(tables.includes('replication_log'));
      for (const retired of [
        'replication_operations',
        'replication_peer_progress',
        'replication_conflicts',
        'queue_entries',
      ]) {
        assert.equal(tables.includes(retired), false, `${retired} is dropped`);
      }
      const settings = Object.fromEntries(
        migrated
          .prepare('SELECT key, value FROM settings')
          .all()
          .map((row) => {
            const { key, value } = row as { key: string; value: string };
            return [key, value];
          })
      );
      assert.equal(settings.schema_version, '14');
      for (const retired of [
        'replication_cluster_secret',
        'replication_checkpoint_gzip_v1',
        'timing_controller_host_id',
      ]) {
        assert.equal(settings[retired], undefined, `${retired} is removed`);
      }
      assert.deepEqual(migrated.prepare("SELECT label_id FROM runner_labels WHERE runner_id = 'alice'").pluck().all(), [
        'blue',
      ]);
      const memberColumns = migrated.prepare('PRAGMA table_info(temporary_team_members)').all() as Array<{
        name: string;
      }>;
      assert.equal(
        memberColumns.some((column) => column.name === 'restore_label_ids_json'),
        false
      );
      const teamColumns = migrated.prepare('PRAGMA table_info(temporary_teams)').all() as Array<{ name: string }>;
      assert.equal(
        teamColumns.some((column) => column.name === 'schedule_owner_host_id'),
        false
      );
      assert.equal(migrated.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      migrated.close();
    }
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
