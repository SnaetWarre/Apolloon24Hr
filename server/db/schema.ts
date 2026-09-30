import { type LabelInput } from '../../shared/schemas.js';
import { all, getDb, one, run, transaction } from './connection.js';
import { TEMPORARY_TEAM_KIND, createLabelRecord, findLabelByName } from './labels.js';
import { type SchemaProblem, type TableShape, referenceSchema, schemaProblems } from './schema-check.js';
import { RUNNER_QUEUE_INDEX_SQL, SCHEMA_SQL } from './schema-sql.js';
import { getSetting, setLocalSetting } from './settings.js';
import { parseLabelsJson, parseStringArray, serializeHistoricalLabels } from './values.js';

export const DATABASE_SCHEMA_VERSION = 14;

type DefaultLabel = Required<LabelInput> & { id: string };

const DEFAULT_LABEL_CREATED_AT = 1_700_000_000_000;

const DEFAULT_LABELS: DefaultLabel[] = [
  {
    id: '00000000-0000-5000-8000-000000000001',
    name: 'Speedteam White',
    color: '#e5e7eb',
    icon: 'SW',
    kind: 'speedteam',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 10,
  },
  {
    id: '00000000-0000-5000-8000-000000000002',
    name: 'Speedteam Blue',
    color: '#1d4ed8',
    icon: 'SB',
    kind: 'speedteam',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 20,
  },
  {
    id: '00000000-0000-5000-8000-000000000003',
    name: 'HILOK',
    color: '#16a34a',
    icon: 'HI',
    kind: 'zustervereniging',
    imageUrl: '/labels/hilok.png',
    targetLaps: null,
    sortOrder: 30,
  },
  {
    id: '00000000-0000-5000-8000-000000000004',
    name: 'Mesacosa',
    color: '#f97316',
    icon: 'ME',
    kind: 'zustervereniging',
    imageUrl: '/labels/mesacosa.jpg',
    targetLaps: null,
    sortOrder: 40,
  },
  {
    id: '00000000-0000-5000-8000-000000000005',
    name: 'Kinesia',
    color: '#7c3aed',
    icon: 'KI',
    kind: 'zustervereniging',
    imageUrl: '/labels/kinesia.png',
    targetLaps: null,
    sortOrder: 50,
  },
  {
    id: '00000000-0000-5000-8000-000000000006',
    name: '1ste jaar',
    color: '#2563eb',
    icon: '1J',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 60,
  },
  {
    id: '00000000-0000-5000-8000-000000000007',
    name: 'Anciens',
    color: '#64748b',
    icon: 'AN',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 70,
  },
  {
    id: '00000000-0000-5000-8000-000000000008',
    name: 'Dames',
    color: '#db2777',
    icon: 'DA',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 80,
  },
];

/** What a new NOT NULL column without a default gets when a table is rebuilt. */
const COLUMN_FALLBACKS: Record<string, string> = {
  created_at: "CAST(unixepoch('subsec') * 1000 AS INTEGER)",
  updated_at: "CAST(unixepoch('subsec') * 1000 AS INTEGER)",
};

/** Creates missing tables; existing ones are left for `migrateSchema`. */
export function createSchema(): void {
  getDb().exec(SCHEMA_SQL);
}

function tableHasColumn(table: string, column: string): boolean {
  return all<{ name: string }>(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

/** Host-local keys of the retired multi-master replication (schema 7 to 12). */
const RETIRED_SETTING_KEYS = [
  'replication_cluster_secret',
  'replication_hlc_wall_ms',
  'replication_hlc_counter',
  'replication_checkpoint_gzip_v1',
  'replication_checkpoint_json',
  'replication_dead_letters_json',
  'timing_controller_host_id',
  'timing_controller_generation',
  'last_database_compaction_at',
];

/**
 * Runs the data migrations for the stored schema version, then brings every
 * table to the current shape and checks it, all in one transaction. Throws
 * when the database still differs, so the server does not start on a table it
 * cannot read. Foreign keys are off meanwhile so rebuilding a table does not
 * cascade into its laps and labels.
 */
export function migrateSchema(): void {
  const previousVersion = Number(getSetting('schema_version') || 0);
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(() => {
      if (!tableHasColumn('runners', 'registration_json')) {
        run('ALTER TABLE runners ADD COLUMN registration_json TEXT');
      }
      if (!tableHasColumn('race_state', 'active_labels_json')) {
        run('ALTER TABLE race_state ADD COLUMN active_labels_json TEXT');
      }
      if (!tableHasColumn('laps', 'labels_json')) {
        run("ALTER TABLE laps ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!tableHasColumn('temporary_teams', 'starts_at')) {
        run('ALTER TABLE temporary_teams ADD COLUMN starts_at INTEGER');
      }
      if (!tableHasColumn('temporary_teams', 'ends_at')) {
        run('ALTER TABLE temporary_teams ADD COLUMN ends_at INTEGER');
      }
      if (!tableHasColumn('runners', 'status')) moveQueueOntoRunners();
      run(RUNNER_QUEUE_INDEX_SQL);

      if (previousVersion > 0 && previousVersion < 5) snapshotLapLabels();
      if (previousVersion > 0 && previousVersion < 6) {
        run('DROP INDEX IF EXISTS idx_laps_runner_finished');
        run('CREATE INDEX idx_laps_runner_finished ON laps(runner_id, finished_at DESC, duration_ms)');
      }
      if (previousVersion > 0 && previousVersion < 9) compactLapLabels();
      if (previousVersion > 0 && previousVersion < 13) {
        retireMultiMasterReplication();
        deriveTemporaryTeamLabels();
      }

      repairSchema(schemaProblems(db));
      const remaining = schemaProblems(db);
      if (remaining.length) {
        throw new Error(
          `database does not match schema ${DATABASE_SCHEMA_VERSION}: ${remaining.map((problem) => problem.detail).join('; ')}`
        );
      }
      warnAboutForeignKeyViolations();
      run(
        `INSERT OR IGNORE INTO race_state (
          id,
          active_runner_id,
          active_started_at,
          race_started_at,
          race_finished_at
        ) VALUES (1, NULL, NULL, NULL, NULL)`
      );
      setLocalSetting('schema_version', String(DATABASE_SCHEMA_VERSION));
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  db.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
}

/**
 * Fixes what `schemaProblems` found. SQLite cannot change a column, check or
 * key in place, so such a table is copied into a fresh one with the same rows
 * and ids; a wrong or missing index is created again.
 */
function repairSchema(problems: SchemaProblem[]): void {
  if (!problems.length) return;
  console.warn(`Repairing database schema: ${problems.map((problem) => problem.detail).join('; ')}`);
  const reference = referenceSchema();
  const rebuilt = new Set<string>();
  for (const problem of problems) {
    if (problem.kind !== 'table' || rebuilt.has(problem.table)) continue;
    rebuildTable(problem.table, reference.get(problem.table)!);
    rebuilt.add(problem.table);
  }
  for (const problem of problems) {
    if (problem.kind !== 'index' || rebuilt.has(problem.table)) continue;
    getDb().exec(`DROP INDEX IF EXISTS "${problem.index}"`);
    const sql = reference.get(problem.table)?.indexes.get(problem.index)?.sql;
    if (sql) getDb().exec(sql);
  }
}

function rebuildTable(table: string, shape: TableShape): void {
  const db = getDb();
  const existing = new Set(all<{ name: string }>(`PRAGMA table_info("${table}")`).map((column) => column.name));
  if (existing.size) {
    const temporary = `${table}__rebuilt`;
    db.exec(`DROP TABLE IF EXISTS "${temporary}"`);
    db.exec(`CREATE TABLE "${temporary}" ${shape.sql.slice(shape.sql.indexOf('('))}`);
    const columns = [...shape.columns.keys()];
    const values = [...shape.columns].map(([name, column]) => {
      const fallback = column.defaultSql ?? COLUMN_FALLBACKS[name] ?? null;
      if (!existing.has(name)) return fallback ?? 'NULL';
      return column.notNull && fallback ? `COALESCE("${name}", ${fallback})` : `"${name}"`;
    });
    db.exec(
      `INSERT INTO "${temporary}" (${columns.map((name) => `"${name}"`).join(', ')}) SELECT ${values.join(', ')} FROM "${table}"`
    );
    db.exec(`DROP TABLE "${table}"`);
    db.exec(`ALTER TABLE "${temporary}" RENAME TO "${table}"`);
  } else {
    db.exec(shape.sql);
  }
  for (const index of shape.indexes.values()) db.exec(index.sql);
}

/** Rows that point at a missing parent predate the repair; they are reported, not removed. */
function warnAboutForeignKeyViolations(): void {
  const counts = new Map<string, number>();
  for (const violation of all<{ table: string }>('PRAGMA foreign_key_check')) {
    counts.set(violation.table, (counts.get(violation.table) ?? 0) + 1);
  }
  if (counts.size) {
    console.warn(
      `Database rows without their parent row: ${[...counts].map(([table, count]) => `${table} ${count}`).join(', ')}`
    );
  }
}

/** Schema 5 started storing each lap's labels; older laps get the runner's labels at migration time. */
function snapshotLapLabels(): void {
  const labelsByRunner = new Map<string, unknown[]>();
  for (const row of all<Record<string, string | number | null> & { runnerId: string }>(
    `SELECT rl.runner_id AS runnerId, l.id, l.name, l.color, l.icon, l.kind, l.image_url AS imageUrl
     FROM runner_labels rl JOIN labels l ON l.id = rl.label_id`
  )) {
    const { runnerId, ...label } = row;
    labelsByRunner.set(runnerId, [...(labelsByRunner.get(runnerId) ?? []), label]);
  }
  for (const lap of all<{ id: string; runnerId: string }>('SELECT id, runner_id AS runnerId FROM laps')) {
    run('UPDATE laps SET labels_json = ? WHERE id = ?', [
      JSON.stringify(labelsByRunner.get(lap.runnerId) ?? []),
      lap.id,
    ]);
  }
  const active = one<{ runnerId: string | null }>('SELECT active_runner_id AS runnerId FROM race_state WHERE id = 1');
  if (active?.runnerId) {
    run('UPDATE race_state SET active_labels_json = ? WHERE id = 1', [
      JSON.stringify(labelsByRunner.get(active.runnerId) ?? []),
    ]);
  }
}

/** Schema 9 dropped live-only label fields from the per-lap label snapshots. */
function compactLapLabels(): void {
  for (const lap of all<{ id: string; labelsJson: string }>('SELECT id, labels_json AS labelsJson FROM laps')) {
    const compact = serializeHistoricalLabels(parseLabelsJson(lap.labelsJson));
    if (compact !== lap.labelsJson) run('UPDATE laps SET labels_json = ? WHERE id = ?', [compact, lap.id]);
  }
}

/** Schema 13 keeps each runner's queue state on the runner itself instead of a 1:1 `queue_entries` row. */
function moveQueueOntoRunners(): void {
  run(`ALTER TABLE runners ADD COLUMN status TEXT NOT NULL DEFAULT 'registered'
       CHECK(status IN ('registered','warming_up','waiting','running','ran'))`);
  run('ALTER TABLE runners ADD COLUMN queue_index INTEGER');
  run('ALTER TABLE runners ADD COLUMN status_since INTEGER');
  run('ALTER TABLE runners ADD COLUMN hidden_at INTEGER');
  if (all('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', 'queue_entries']).length) {
    run(`UPDATE runners
         SET status = q.status, queue_index = q.queue_index, status_since = q.status_since, hidden_at = q.hidden_at
         FROM queue_entries q
         WHERE q.runner_id = runners.id`);
    run('DROP TABLE queue_entries');
  }
}

/** Schema 13 replaced multi-master replication with a single primary and log-shipping standbys. */
function retireMultiMasterReplication(): void {
  run('DROP TABLE IF EXISTS cluster_operations');
  run('DROP TABLE IF EXISTS replication_operations');
  run('DROP TABLE IF EXISTS replication_peer_progress');
  run('DROP TABLE IF EXISTS replication_conflicts');
  run(`DELETE FROM settings WHERE key IN (${RETIRED_SETTING_KEYS.map(() => '?').join(', ')})`, RETIRED_SETTING_KEYS);
}

/**
 * Before schema 13 an active night team rewrote its members' labels and kept
 * the originals aside. Labels are now derived from the schedule, so restore
 * the originals and drop the bookkeeping columns.
 */
function deriveTemporaryTeamLabels(): void {
  if (tableHasColumn('temporary_team_members', 'restore_label_ids_json')) {
    for (const member of all<{
      teamId: string;
      runnerId: string;
      restoreJson: string | null;
    }>(
      `SELECT team_label_id AS teamId, runner_id AS runnerId, restore_label_ids_json AS restoreJson
       FROM temporary_team_members WHERE restore_label_ids_json IS NOT NULL`
    )) {
      for (const labelId of parseStringArray(member.restoreJson)) {
        run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) SELECT ?, id FROM labels WHERE id = ?', [
          member.runnerId,
          labelId,
        ]);
      }
    }
    run('ALTER TABLE temporary_team_members DROP COLUMN restore_label_ids_json');
  }
  if (tableHasColumn('temporary_teams', 'schedule_owner_host_id')) {
    run('ALTER TABLE temporary_teams DROP COLUMN schedule_owner_host_id');
  }
  run('DELETE FROM runner_labels WHERE label_id IN (SELECT id FROM labels WHERE kind = ?)', [TEMPORARY_TEAM_KIND]);
  run('UPDATE temporary_teams SET active = 0, activated_at = NULL WHERE starts_at IS NOT NULL AND ends_at IS NOT NULL');
}

export function seedDefaultLabels(): void {
  for (const label of DEFAULT_LABELS) {
    const existing = findLabelByName(label.name);
    if (existing) {
      run(
        `UPDATE labels
         SET color = ?,
             icon = ?,
             kind = ?,
             image_url = ?,
             target_laps = COALESCE(target_laps, ?),
             sort_order = COALESCE(sort_order, ?)
         WHERE id = ?`,
        [label.color, label.icon, label.kind, label.imageUrl, label.targetLaps, label.sortOrder, existing.id]
      );
      continue;
    }
    createLabelRecord(label, label.id, DEFAULT_LABEL_CREATED_AT);
  }
}
