import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const dataPath = path.resolve(`.tmp-test-schema-repair-${process.pid}`);
const dataDir = path.join(dataPath, 'data');
const databasePath = path.join(dataDir, 'app.db');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

/** Creates a database with the current schema, then lets `change` damage it. */
async function currentDatabaseChangedBy(change: string): Promise<void> {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  await db.initDb();
  db.insertRunner({ name: 'Anna', runnerNumber: '1' });
  db.closeDb();
  const raw = new DatabaseSync(databasePath);
  raw.exec(`PRAGMA foreign_keys = OFF; ${change}`);
  raw.close();
}

test('any table that drifted from the schema is rebuilt with its rows, not only runners', async () => {
  await currentDatabaseChangedBy(`
    ALTER TABLE labels ADD COLUMN legacy_code TEXT NOT NULL DEFAULT 'x';
    DROP INDEX idx_laps_finished;
    CREATE INDEX idx_laps_finished ON laps(created_at);
  `);
  const labelCount = (
    new DatabaseSync(databasePath, { readOnly: true }).prepare('SELECT count(*) AS n FROM labels').get() as {
      n: number;
    }
  ).n;

  const db = await import('../server/db.ts');
  const { schemaProblems } = await import('../server/db/schema-check.ts');
  try {
    await db.initDb();
    assert.equal(db.getLabels().length, labelCount);
    assert.ok(db.createLabel({ name: 'Nieuw', color: '#000000', icon: 'NW', kind: 'andere' }));
    assert.equal(db.getAllRunners()[0]?.name, 'Anna');
  } finally {
    db.closeDb();
  }
  const repaired = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(schemaProblems(repaired), []);
  } finally {
    repaired.close();
  }
  assert.equal(
    fs.readdirSync(dataDir).filter((file) => file.startsWith('app.pre-repair-')).length,
    1,
    'keeps a copy first'
  );
  fs.rmSync(dataPath, { recursive: true, force: true });
});

test('rows the current schema cannot hold stop the start and leave the database as it was', async () => {
  // An old table without the status check, holding a status that no longer exists.
  await currentDatabaseChangedBy(`
    CREATE TABLE runners_old AS SELECT * FROM runners;
    DROP TABLE runners;
    ALTER TABLE runners_old RENAME TO runners;
    UPDATE runners SET status = 'sprinting';
  `);

  const db = await import('../server/db.ts');
  try {
    await assert.rejects(db.initDb(), /CHECK constraint failed/);
  } finally {
    db.closeDb();
  }
  const untouched = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.deepEqual(
      untouched
        .prepare('SELECT name, status FROM runners')
        .all()
        .map((row) => ({ ...row })),
      [{ name: 'Anna', status: 'sprinting' }]
    );
    const sql = (untouched.prepare("SELECT sql FROM sqlite_master WHERE name = 'runners'").get() as { sql: string })
      .sql;
    assert.doesNotMatch(sql, /CHECK/, 'the old table is still in place');
  } finally {
    untouched.close();
  }
  fs.rmSync(dataPath, { recursive: true, force: true });
});
