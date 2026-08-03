import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const dataPath = path.resolve(`.tmp-test-storage-${process.pid}`);
const databaseDirectory = path.join(dataPath, 'data');
const databasePath = path.join(databaseDirectory, 'app.db');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';
process.env.DATABASE_COMPACTION_MIN_BYTES = '1024';
process.env.DATABASE_COMPACTION_MIN_RATIO = '0.10';

test('schema migration removes the retired log and compaction never runs during a race', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  fs.mkdirSync(databaseDirectory, { recursive: true });
  const legacy = new Database(databasePath);
  try {
    legacy.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings(key, value) VALUES ('schema_version', '7');
      CREATE TABLE cluster_operations (
        seq INTEGER PRIMARY KEY,
        payload_json BLOB NOT NULL
      );
      INSERT INTO cluster_operations(payload_json) VALUES (randomblob(4 * 1024 * 1024));
    `);
  } finally {
    legacy.close();
  }
  const legacyBytes = fs.statSync(databasePath).size;

  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    const migrated = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const retiredTable = migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cluster_operations'")
        .get();
      assert.equal(retiredTable, undefined);
      assert.equal(
        migrated.prepare("SELECT value FROM settings WHERE key = 'schema_version'").pluck().get(),
        '8'
      );
      assert.equal(migrated.pragma('user_version', { simple: true }), 8);
      assert.equal(migrated.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      migrated.close();
    }
    const migrationStorage = db.databaseStorageStatus();
    assert.equal(migrationStorage.compactionRecommended, true);
    const startupCompaction = db.compactDatabaseIfSafe();
    assert.equal(startupCompaction.compacted, true);
    assert.ok(fs.statSync(databasePath).size < legacyBytes / 2);

    db.closeDb();
    const bloated = new Database(databasePath);
    try {
      bloated.exec(`
        UPDATE race_state
        SET race_started_at = 1700000000000,
            race_finished_at = NULL,
            active_runner_id = NULL
        WHERE id = 1;
        CREATE TABLE compaction_test_payload (payload BLOB NOT NULL);
        INSERT INTO compaction_test_payload(payload) VALUES (randomblob(4 * 1024 * 1024));
        DROP TABLE compaction_test_payload;
      `);
    } finally {
      bloated.close();
    }

    await db.initDb();
    const activeStatus = db.databaseStorageStatus();
    assert.equal(activeStatus.raceActive, true);
    assert.equal(activeStatus.compactionRecommended, true);
    const blocked = db.compactDatabaseIfSafe({ force: true });
    assert.equal(blocked.compacted, false);
    assert.equal(blocked.reason, 'race-active');

    db.finishRace(Date.now());
    const compacted = db.compactDatabaseIfSafe({ force: true });
    assert.equal(compacted.compacted, true);
    assert.ok(compacted.after.fileBytes < compacted.before.fileBytes / 2);
    assert.equal(compacted.after.reclaimablePercent < 10, true);
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
