import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const dataPath = path.resolve(`.tmp-test-schema-early-runners-${process.pid}`);
const databasePath = path.join(dataPath, 'data', 'app.db');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

/** The earliest `runners` table: few columns, and a status check without 'registered' or 'running'. */
const EARLY_SCHEMA = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE runners (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('warming_up','waiting','ran')),
    status_since INTEGER,
    queue_index INTEGER
  , registration_json TEXT);
  CREATE TABLE laps (
    id TEXT PRIMARY KEY, runner_id TEXT NOT NULL, lap_number INTEGER NOT NULL, started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]', FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
  );
  INSERT INTO settings VALUES ('schema_version', '14'), ('host_id', 'early-host'), ('replication_cluster_id', 'c');
  INSERT INTO runners (id, name, status, status_since, queue_index) VALUES ('dora', 'Dora', 'waiting', 100, 0);
  INSERT INTO laps VALUES ('lap-1', 'dora', 1, 0, 60000, 60000, 'manual', 60000, '[]');
`;

test('an early runners table is rebuilt with every current column, keeping its runners and their laps', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const early = new DatabaseSync(databasePath);
  early.exec(EARLY_SCHEMA);
  early.close();

  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    const [dora] = db.getAllRunners();
    assert.equal(dora?.id, 'dora');
    assert.equal(dora?.status, 'waiting');
    assert.equal(dora?.queueIndex, 0);
    assert.equal(dora?.registrationSource, 'manual');
    assert.equal(dora?.lapCount, 1, 'the lap survives the rebuild');
    assert.ok((dora?.createdAt ?? 0) > 0);

    // The old check rejected these statuses.
    db.updateRunnerStatus({ id: 'dora', status: 'registered' });
    assert.equal(db.getRunnerById('dora')?.status, 'registered');
    assert.ok(db.insertRunner({ name: 'Emil' }));
    assert.equal(db.databaseReadiness().ready, true);
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
