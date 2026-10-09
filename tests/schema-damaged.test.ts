import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('schema-damaged');
const dataDir = path.join(dataPath, 'data');
const backupDir = path.join(dataPath, 'backups');
const databasePath = path.join(dataDir, 'app.db');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

/** A database whose header is fine but whose table pages a disk error overwrote. */
function malformedDatabase(): Buffer {
  const scratch = path.join(dataPath, 'scratch.sqlite');
  const db = new DatabaseSync(scratch);
  db.exec('CREATE TABLE runners (id INTEGER PRIMARY KEY, name TEXT); CREATE INDEX runners_name ON runners(name);');
  const insert = db.prepare('INSERT INTO runners (name) VALUES (?)');
  for (let index = 0; index < 2_000; index++) insert.run(`Loper ${index}`);
  db.close();
  const bytes = fs.readFileSync(scratch);
  fs.rmSync(scratch);
  crypto.randomBytes(4_096).copy(bytes, 4_096 * 3);
  return bytes;
}

for (const [name, damaged, wal] of [
  ['a file that is not a database', () => crypto.randomBytes(20_000), true],
  ['a database with damaged pages', malformedDatabase, false],
] as const) {
  test(`${name} is put aside untouched, the backups stay, and the app starts empty`, async () => {
    fs.rmSync(dataPath, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    const bytes = damaged();
    fs.writeFileSync(databasePath, bytes);
    if (wal) fs.writeFileSync(`${databasePath}-wal`, 'half a write-ahead log');
    const backup = path.join(backupDir, 'apolloon-scheduled-2026-10-09T10-00-00-000Z.sqlite');
    fs.writeFileSync(backup, 'a backup');

    const db = await import('../server/db.ts');
    try {
      await db.initDb();
      assert.deepEqual(db.getAllRunners(), []);
      assert.equal(db.databaseReadiness().schemaVersion, db.DATABASE_SCHEMA_VERSION);
      assert.ok(db.getLabels().length > 0, 'a new database gets the built-in labels');
      assert.ok(db.insertRunner({ name: 'Nieuw', runnerNumber: '1' }));
      const putAside = db.damagedDatabase();
      assert.match(putAside?.fileName ?? '', /^app\.damaged-.*\.sqlite$/);

      assert.ok(fs.readFileSync(path.join(dataDir, putAside!.fileName)).equals(bytes), 'kept byte for byte');
      assert.equal(fs.existsSync(path.join(dataDir, `${putAside!.fileName}-wal`)), wal, 'its log goes with it');
      assert.deepEqual(fs.readdirSync(backupDir), [path.basename(backup)]);
      assert.equal(fs.readFileSync(backup, 'utf8'), 'a backup');
    } finally {
      db.closeDb();
    }
    fs.rmSync(dataPath, { recursive: true, force: true });
  });
}

test('a healthy database is not put aside', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    db.insertRunner({ name: 'Blijft', runnerNumber: '1' });
    db.closeDb();
    await db.initDb();
    assert.deepEqual(
      db.getAllRunners().map((runner) => runner.name),
      ['Blijft']
    );
    assert.equal(db.damagedDatabase(), null);
    assert.deepEqual(
      fs.readdirSync(dataDir).filter((file) => file.includes('damaged')),
      []
    );
  } finally {
    db.closeDb();
  }
  fs.rmSync(dataPath, { recursive: true, force: true });
});
