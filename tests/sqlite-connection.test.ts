import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import test from 'node:test';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('sqlite-connection');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

async function freshDatabase() {
  const db = await import('../server/db.ts');
  db.closeDb();
  fs.rmSync(dataPath, { recursive: true, force: true });
  await db.initDb();
  const connection = await import('../server/db/connection.ts');
  connection.run('CREATE TABLE IF NOT EXISTS scratch (value TEXT NOT NULL)');
  const values = () =>
    connection.all<{ value: string }>('SELECT value FROM scratch ORDER BY rowid').map((row) => row.value);
  return { db, connection, values };
}

test.after(() => fs.rmSync(dataPath, { recursive: true, force: true }));

test('a failing nested transaction undoes only its own savepoint', async () => {
  const { db, connection, values } = await freshDatabase();
  try {
    connection.transaction(() => {
      connection.run("INSERT INTO scratch VALUES ('outer before')");
      assert.throws(
        () =>
          connection.transaction(() => {
            connection.run("INSERT INTO scratch VALUES ('inner')");
            throw new Error('inner failure');
          }),
        /inner failure/
      );
      connection.transaction(() => connection.run("INSERT INTO scratch VALUES ('inner kept')"));
      connection.run("INSERT INTO scratch VALUES ('outer after')");
    });
    assert.deepEqual(values(), ['outer before', 'inner kept', 'outer after']);
    assert.equal(connection.getDb().isTransaction, false);
  } finally {
    db.closeDb();
  }
});

test('a failing outer transaction undoes its released savepoints too', async () => {
  const { db, connection, values } = await freshDatabase();
  try {
    assert.throws(
      () =>
        connection.transaction(() => {
          connection.transaction(() => connection.run("INSERT INTO scratch VALUES ('inner')"));
          throw new Error('outer failure');
        }),
      /outer failure/
    );
    assert.throws(() => connection.transaction(() => Promise.resolve()), /cannot return a promise/);
    assert.deepEqual(values(), []);
    assert.equal(connection.getDb().isTransaction, false);
  } finally {
    db.closeDb();
  }
});

test('a replicated write with nested transactions logs one entry without the undone statements', async () => {
  const { db, connection } = await freshDatabase();
  try {
    db.recordWrite('test.nested', () => {
      connection.transaction(() => connection.run("INSERT INTO scratch VALUES ('kept')"));
      assert.throws(() =>
        connection.transaction(() => {
          connection.run("INSERT INTO scratch VALUES ('undone')");
          throw new Error('inner failure');
        })
      );
      connection.run("INSERT INTO scratch VALUES ('after')");
    });
    const entries = db.getLogEntriesAfter(0);
    assert.equal(entries.length, 1);
    assert.deepEqual(
      entries[0].statements.map((statement) => statement.sql),
      ["INSERT INTO scratch VALUES ('kept')", "INSERT INTO scratch VALUES ('after')"]
    );
  } finally {
    db.closeDb();
  }
});

// Electron pins the Node.js release; this fails CI if an upgrade changes what the app relies on.
test('node:sqlite still behaves the way the database layer expects', async () => {
  fs.mkdirSync(dataPath, { recursive: true });
  const database = new DatabaseSync(':memory:');
  try {
    assert.equal(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
    assert.throws(() => database.prepare('SELECT "not a column"').get(), /no such column/);

    database.exec('CREATE TABLE t (text_value TEXT, int_value INTEGER, any_value)');
    const result = database.prepare('INSERT INTO t VALUES (?, ?, ?)').run(5, 5, 5.5);
    assert.deepEqual({ ...result }, { changes: 1, lastInsertRowid: 1 });
    assert.deepEqual(
      { ...database.prepare('SELECT text_value, typeof(int_value) AS intType, any_value FROM t').get() },
      { text_value: '5.0', intType: 'integer', any_value: 5.5 }
    );

    assert.equal(database.isTransaction, false);
    database.exec('BEGIN; SAVEPOINT s');
    assert.equal(database.isTransaction, true);
    database.exec('ROLLBACK TO s; RELEASE s; ROLLBACK');
    assert.equal(database.isTransaction, false);

    const image = database.serialize();
    assert.ok(image instanceof Uint8Array && image.byteLength > 0);
    const imagePath = path.join(dataPath, 'contract.sqlite');
    fs.writeFileSync(imagePath, image);
    const copyPath = path.join(dataPath, 'contract-backup.sqlite');
    const source = new DatabaseSync(imagePath);
    await backup(source, copyPath);
    source.close();
    const copy = new DatabaseSync(copyPath, { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
      assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM t').get()?.count, 1);
    } finally {
      copy.close();
    }
  } finally {
    database.close();
  }
});
