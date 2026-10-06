import { type LabelInput } from '../../shared/schemas.js';
import { all, getDb, one, run, transaction } from './connection.js';
import { createLabelRecord, findLabelByName } from './labels.js';
import { type SchemaProblem, type TableShape, referenceSchema, schemaProblems } from './schema-check.js';
import { RUNNER_QUEUE_INDEX_SQL, SCHEMA_SQL } from './schema-sql.js';
import { setLocalSetting } from './settings.js';

export const DATABASE_SCHEMA_VERSION = 15;

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

/**
 * Brings every table to the current shape and checks it, in one transaction.
 * Throws when the database still differs, so the server does not start on a
 * table it cannot read. Foreign keys are off meanwhile so rebuilding a table
 * does not cascade into its laps and labels. Databases from before 4.0 never
 * get here: `initDb` puts them aside.
 */
export function migrateSchema(): void {
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(() => {
      run(RUNNER_QUEUE_INDEX_SQL);
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

/**
 * Adds the built-in labels to a database created on this start. Runs outside
 * `recordWrite`, so it must never touch a database that already holds event
 * data: a renamed, edited or deleted built-in label is the operator's choice
 * and has already reached the other laptops. A default whose id or name is
 * taken is skipped, never overwritten.
 */
export function seedDefaultLabels(): void {
  transaction(() => {
    for (const label of DEFAULT_LABELS) {
      if (one('SELECT 1 FROM labels WHERE id = ?', [label.id]) || findLabelByName(label.name)) continue;
      createLabelRecord(label, label.id, DEFAULT_LABEL_CREATED_AT);
    }
  });
}
