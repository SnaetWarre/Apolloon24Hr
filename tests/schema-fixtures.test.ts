import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { schemaProblems } from '../server/db/schema-check.ts';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('schema-fixtures');
const dataDir = path.join(dataPath, 'data');
const databasePath = path.join(dataDir, 'app.db');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

/** Databases made by released versions; `scripts/make-db-fixture.mjs` adds one per release. */
const fixtureDir = path.resolve('tests', 'fixtures', 'db');
const fixtures = fs
  .readdirSync(fixtureDir)
  .filter((file) => file.endsWith('.sqlite'))
  .sort();

/**
 * The last release: its tables must already match, so none is rebuilt. Tables added
 * since are only missing, and are created without a rebuild or a repair copy.
 */
const LATEST_RELEASE_FIXTURE = 'v4.1.0.sqlite';

type StoredRunner = { name: string; status: string; laps: number };

/** Runners with their queue status and lap count, read straight from the file as that version stored them. */
function storedRunners(file: string): Map<string, StoredRunner> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT r.id, r.name, r.status, (SELECT count(*) FROM laps l WHERE l.runner_id = r.id) AS laps FROM runners r`
      )
      .all() as Array<StoredRunner & { id: string }>;
    return new Map(rows.map(({ id, ...runner }) => [id, runner]));
  } finally {
    db.close();
  }
}

function openedProblems(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return schemaProblems(db);
  } finally {
    db.close();
  }
}

test('there is a database from each 4.x schema this app has shipped', () => {
  for (const release of ['v4.0.0', 'v4.0.1-early-runners']) {
    assert.ok(fixtures.includes(`${release}.sqlite`), `${release}.sqlite is missing`);
  }
  assert.ok(fixtures.includes(LATEST_RELEASE_FIXTURE));
});

test('a fresh database matches the schema it is checked against', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  try {
    await db.initDb();
  } finally {
    db.closeDb();
  }
  assert.deepEqual(openedProblems(databasePath), []);
  assert.deepEqual(
    fs.readdirSync(dataDir).filter((file) => file.startsWith('app.pre-')),
    [],
    'a fresh database needs no repair copy'
  );
  fs.rmSync(dataPath, { recursive: true, force: true });
});

for (const fixture of fixtures) {
  test(`a database from ${fixture.replace('.sqlite', '')} starts, keeps its runners and laps, and takes new laps`, async () => {
    fs.rmSync(dataPath, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(path.join(fixtureDir, fixture), databasePath);
    const before = storedRunners(databasePath);
    if (fixture === LATEST_RELEASE_FIXTURE) {
      assert.deepEqual(
        openedProblems(databasePath).filter((problem) => !problem.detail.endsWith('table is missing')),
        []
      );
    }

    const db = await import('../server/db.ts');
    const { liveAppSnapshot } = await import('../server/app-state.ts');
    try {
      await db.initDb();

      // What /api/state sends: this is what failed with "no such column" in 4.0.1.
      const snapshot = liveAppSnapshot();
      assert.deepEqual(
        Object.fromEntries(
          snapshot.runners.map((runner) => [
            runner.id,
            { name: runner.name, status: runner.status, laps: runner.lapCount },
          ])
        ),
        Object.fromEntries(
          [...before].map(([id, runner]) => [id, { name: runner.name, status: runner.status, laps: runner.laps }])
        )
      );
      assert.equal(snapshot.labels.length > 0, true, 'default labels are there');

      const lapsBefore = snapshot.runners.reduce((total, runner) => total + runner.lapCount, 0);
      const first = db.insertRunner({ name: 'Nieuwe loper', runnerNumber: '901' });
      const second = db.insertRunner({ name: 'Tweede loper', runnerNumber: '902' });
      db.updateRunnerStatus({ id: first.id, status: 'waiting', statusSince: 5_000, queueIndex: 100 });
      db.updateRunnerStatus({ id: second.id, status: 'waiting', statusSince: 5_000, queueIndex: 101 });
      assert.equal(db.performHandoff(10_000_000).ok, true);
      const lap = db.performHandoff(10_060_000);
      assert.equal(lap.ok, true);
      assert.ok(lap.ok && lap.lapId, 'the second press records a lap');
      assert.equal(
        liveAppSnapshot().runners.reduce((total, runner) => total + runner.lapCount, 0),
        lapsBefore + 1
      );
      assert.equal(db.databaseReadiness().schemaVersion, db.DATABASE_SCHEMA_VERSION);
    } finally {
      db.closeDb();
    }

    assert.deepEqual(openedProblems(databasePath), [], 'the stored tables now match a fresh database');
    const copies = fs.readdirSync(dataDir).filter((file) => file.startsWith('app.pre-'));
    if (fixture === LATEST_RELEASE_FIXTURE) assert.deepEqual(copies, [], 'nothing to repair, so no copy');
    fs.rmSync(dataPath, { recursive: true, force: true });
  });
}
