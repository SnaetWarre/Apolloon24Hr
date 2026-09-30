import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('schema-retire');
const dataDir = path.join(dataPath, 'data');
const databasePath = path.join(dataDir, 'app.db');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

/** A 3.x database: schema 12, the queue in its own table, multi-master replication. */
const SCHEMA_12 = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE runners (
    id TEXT PRIMARY KEY, runner_number TEXT UNIQUE, name TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE queue_entries (runner_id TEXT PRIMARY KEY, status TEXT NOT NULL, queue_index INTEGER);
  CREATE TABLE replication_operations (id TEXT PRIMARY KEY, statements_json TEXT NOT NULL);
  INSERT INTO settings VALUES ('schema_version', '12'), ('host_id', 'old-host');
  INSERT INTO runners VALUES ('alice', '1', 'Alice', 1, 1), ('bob', '2', 'Bob', 1, 1);
  INSERT INTO queue_entries VALUES ('alice', 'waiting', 0);
`;

/** The first versions stored no schema version at all. */
const FIRST_VERSION = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE runners (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('warming_up','waiting','ran')), status_since INTEGER, queue_index INTEGER
  );
  INSERT INTO settings VALUES ('host_id', 'old-host');
  INSERT INTO runners VALUES ('alice', 'Alice', 'waiting', 100, 0), ('bob', 'Bob', 'ran', 200, NULL);
`;

for (const [name, schema] of [
  ['3.x (schema 12)', SCHEMA_12],
  ['the first versions (no schema version)', FIRST_VERSION],
] as const) {
  test(`a database from ${name} is put aside untouched and the app starts empty`, async () => {
    fs.rmSync(dataPath, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const old = new DatabaseSync(databasePath);
    old.exec(schema);
    old.close();

    const db = await import('../server/db.ts');
    try {
      await db.initDb();
      assert.deepEqual(db.getAllRunners(), []);
      assert.notEqual(db.hostIdentity().hostId, 'old-host', 'a new laptop identity');
      assert.equal(db.databaseReadiness().schemaVersion, db.DATABASE_SCHEMA_VERSION);
      assert.ok(db.insertRunner({ name: 'Nieuw', runnerNumber: '1' }));
    } finally {
      db.closeDb();
    }

    const files = fs.readdirSync(dataDir);
    assert.deepEqual(
      files.filter((file) => file.startsWith('app.pre-')),
      [],
      'nothing is converted, so no repair copy'
    );
    const retired = files.filter((file) => /^app\.retired-.*\.sqlite$/.test(file));
    assert.equal(retired.length, 1);
    const kept = new DatabaseSync(path.join(dataDir, retired[0]!), { readOnly: true });
    try {
      assert.deepEqual(
        kept
          .prepare('SELECT name FROM runners ORDER BY name')
          .all()
          .map((row) => row.name),
        ['Alice', 'Bob']
      );
    } finally {
      kept.close();
    }
    fs.rmSync(dataPath, { recursive: true, force: true });
  });
}
