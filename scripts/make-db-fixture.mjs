// Builds tests/fixtures/db/<tag>.sqlite: the database a released version
// creates, with a few runners and laps, for the upgrade tests.
//
//   node scripts/make-db-fixture.mjs v4.0.3
//
// The tag is checked out in a temporary worktree and its own database code
// creates the tables. Only 4.0 and later: the app puts older databases aside.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const tags = process.argv.slice(2);
if (!tags.length) {
  console.error('Usage: node scripts/make-db-fixture.mjs <tag> [tag...]');
  process.exit(1);
}

const repo = path.resolve(import.meta.dirname, '..');
const fixtures = path.join(repo, 'tests', 'fixtures', 'db');
const tsx = pathToFileURL(path.join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'apolloon-db-fixture-'));

const RUNNERS = [
  { id: 'fixture-anna', runner_number: '1', name: 'Anna', status: 'waiting', queue_index: 0, status_since: 1_000 },
  { id: 'fixture-bert', runner_number: '2', name: 'Bert', status: 'ran', queue_index: null, status_since: 2_000 },
  { id: 'fixture-cas', runner_number: '3', name: 'Cas', status: 'warming_up', queue_index: null, status_since: 3_000 },
];

const LAPS = [
  { id: 'fixture-lap-1', runner_id: 'fixture-bert', lap_number: 1, started_at: 0, finished_at: 61_000 },
  { id: 'fixture-lap-2', runner_id: 'fixture-bert', lap_number: 2, started_at: 61_000, finished_at: 119_500 },
  { id: 'fixture-lap-3', runner_id: 'fixture-anna', lap_number: 1, started_at: 119_500, finished_at: 185_250 },
];

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

/** Lets the tag's own code create its database in `dataPath`. */
function createWithRelease(tag, worktree, dataPath) {
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(worktree, 'node_modules'));
  const script = `
    const db = await import(${JSON.stringify(pathToFileURL(path.join(worktree, 'server', 'db.ts')).href)});
    await db.initDb();
    db.closeDb();
    process.exit(0);
  `;
  execFileSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', script], {
    cwd: worktree,
    env: { ...process.env, DATA_PATH: dataPath, NODE_ENV: 'test' },
    stdio: 'inherit',
  });
}

/** Inserts `row`, keeping only the columns this version's table has. */
function insert(db, table, row) {
  const columns = new Set(
    db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((column) => column.name)
  );
  if (!columns.size) return;
  const entries = Object.entries(row).filter(([column]) => columns.has(column));
  db.prepare(
    `INSERT INTO "${table}" (${entries.map(([column]) => `"${column}"`).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`
  ).run(...entries.map(([, value]) => value));
}

function addSampleData(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec('BEGIN');
    for (const runner of RUNNERS) {
      insert(db, 'runners', {
        ...runner,
        registration_source: 'manual',
        notes: '',
        created_at: 1_000,
        updated_at: 1_000,
      });
    }
    for (const lap of LAPS) {
      insert(db, 'laps', {
        ...lap,
        duration_ms: lap.finished_at - lap.started_at,
        source: 'manual',
        created_at: lap.finished_at,
        labels_json: '[]',
      });
    }
    const label = db.prepare('SELECT id FROM labels ORDER BY name LIMIT 1').get();
    insert(db, 'runner_labels', { runner_id: 'fixture-anna', label_id: label.id });
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;');
  } finally {
    db.close();
  }
}

try {
  fs.mkdirSync(fixtures, { recursive: true });
  for (const tag of tags) {
    const worktree = path.join(temporary, tag);
    const dataPath = path.join(temporary, `${tag}-data`);
    git('worktree', 'add', '--detach', worktree, tag);
    try {
      createWithRelease(tag, worktree, dataPath);
      const file = path.join(dataPath, 'data', 'app.db');
      addSampleData(file);
      fs.copyFileSync(file, path.join(fixtures, `${tag}.sqlite`));
      console.log(`Wrote tests/fixtures/db/${tag}.sqlite`);
    } finally {
      git('worktree', 'remove', '--force', worktree);
    }
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
