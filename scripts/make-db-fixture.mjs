// Builds tests/fixtures/db/<tag>.sqlite: the database a released version
// creates, with a few runners and laps, for the upgrade tests.
//
//   node scripts/make-db-fixture.mjs v0.7.1 v1.0.0 ...
//
// Each tag is checked out in a temporary worktree and its own database code
// creates the tables. Releases before 4.0 used better-sqlite3, which is
// installed once into a temporary folder for them.
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
const legacyModules = path.join(temporary, 'legacy', 'node_modules');

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

function installLegacyModules() {
  if (fs.existsSync(legacyModules)) return;
  const folder = path.dirname(legacyModules);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'package.json'), '{ "private": true }\n');
  execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', 'better-sqlite3@12', 'uuid@14', 'zod@4'], {
    cwd: folder,
    stdio: 'inherit',
  });
}

/** Lets the tag's own code create its database in `dataPath`. */
function createWithRelease(tag, worktree, dataPath) {
  const entry = ['server/db.ts', 'server/db.mjs'].find((file) => fs.existsSync(path.join(worktree, file)));
  if (!entry) throw new Error(`${tag} has no server/db module`);
  const usesNodeSqlite = !JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf8')).dependencies?.[
    'better-sqlite3'
  ];
  if (!usesNodeSqlite) installLegacyModules();
  fs.symlinkSync(usesNodeSqlite ? path.join(repo, 'node_modules') : legacyModules, path.join(worktree, 'node_modules'));
  const script = `
    const db = await import(${JSON.stringify(pathToFileURL(path.join(worktree, entry)).href)});
    if (db.initDb) await db.initDb();
    if (db.closeDb) db.closeDb();
    else db.db?.close();
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

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
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
      if (hasTable(db, 'queue_entries')) {
        insert(db, 'queue_entries', {
          runner_id: runner.id,
          status: runner.status,
          queue_index: runner.queue_index,
          status_since: runner.status_since,
          hidden_at: null,
        });
      }
    }
    if (hasTable(db, 'laps')) {
      for (const lap of LAPS) {
        insert(db, 'laps', {
          ...lap,
          duration_ms: lap.finished_at - lap.started_at,
          source: 'manual',
          created_at: lap.finished_at,
          labels_json: '[]',
        });
      }
    }
    const label = hasTable(db, 'labels') ? db.prepare('SELECT id FROM labels ORDER BY name LIMIT 1').get() : null;
    if (label && hasTable(db, 'runner_labels'))
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
