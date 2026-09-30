import { DatabaseSync } from 'node:sqlite';
import { RUNNER_QUEUE_INDEX_SQL, SCHEMA_SQL } from './schema-sql.js';

export type ColumnShape = {
  /** Type, NOT NULL, default and primary key position, for comparing. */
  description: string;
  notNull: boolean;
  defaultSql: string | null;
};

export type TableShape = {
  sql: string;
  columns: Map<string, ColumnShape>;
  checks: string;
  foreignKeys: string;
  uniques: string;
  indexes: Map<string, { sql: string; normalized: string }>;
};

/**
 * How a database differs from the current schema. A `table` problem (missing
 * table, or different columns, checks, keys or uniqueness) needs the table
 * rebuilt; an `index` problem only needs that index dropped or created again.
 */
export type SchemaProblem =
  | { kind: 'table'; table: string; detail: string }
  | {
      kind: 'index';
      table: string;
      index: string;
      detail: string;
    };

let reference: Map<string, TableShape> | null = null;

/** The tables of a database built fresh from the current schema. */
export function referenceSchema(): Map<string, TableShape> {
  if (reference) return reference;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    db.exec(RUNNER_QUEUE_INDEX_SQL);
    reference = describeTables(db);
  } finally {
    db.close();
  }
  return reference;
}

/**
 * Compares the tables of `db` with the current schema. The stored schema
 * version is not consulted: a database from the earliest versions was once
 * stamped current while its `runners` table was not. Tables the current schema
 * does not know are ignored.
 */
export function schemaProblems(db: DatabaseSync): SchemaProblem[] {
  const actual = describeTables(db);
  const problems: SchemaProblem[] = [];
  for (const [table, expected] of referenceSchema()) {
    const found = actual.get(table);
    if (!found) {
      problems.push({ kind: 'table', table, detail: `${table}: table is missing` });
      continue;
    }
    for (const detail of tableDifferences(expected, found)) {
      problems.push({ kind: 'table', table, detail: `${table}: ${detail}` });
    }
    for (const [index, { normalized }] of expected.indexes) {
      const present = found.indexes.get(index);
      if (present?.normalized === normalized) continue;
      problems.push({
        kind: 'index',
        table,
        index,
        detail: `${table}: index ${index} is ${present ? 'different' : 'missing'}`,
      });
    }
    for (const index of found.indexes.keys()) {
      if (!expected.indexes.has(index)) {
        problems.push({ kind: 'index', table, index, detail: `${table}: index ${index} is not in the schema` });
      }
    }
  }
  return problems;
}

function tableDifferences(expected: TableShape, found: TableShape): string[] {
  const differences: string[] = [];
  for (const [column, shape] of expected.columns) {
    const present = found.columns.get(column);
    if (!present) differences.push(`column ${column} is missing`);
    else if (present.description !== shape.description) {
      differences.push(`column ${column} is ${present.description}, expected ${shape.description}`);
    }
  }
  for (const column of found.columns.keys()) {
    if (!expected.columns.has(column)) differences.push(`column ${column} is not in the schema`);
  }
  if (found.checks !== expected.checks) differences.push('check constraints differ');
  if (found.foreignKeys !== expected.foreignKeys) differences.push('foreign keys differ');
  if (found.uniques !== expected.uniques) differences.push('unique constraints differ');
  return differences;
}

function describeTables(db: DatabaseSync): Map<string, TableShape> {
  const tables = new Map<string, TableShape>();
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string; sql: string }>;
  for (const { name, sql } of rows) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const columns = new Map<string, ColumnShape>();
    for (const column of db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>) {
      const parts = [column.type.toUpperCase()];
      if (column.notnull) parts.push('NOT NULL');
      if (column.dflt_value !== null) parts.push(`DEFAULT ${column.dflt_value}`);
      if (column.pk) parts.push(`PRIMARY KEY ${column.pk}`);
      columns.set(column.name, {
        description: parts.join(' '),
        notNull: Boolean(column.notnull),
        defaultSql: column.dflt_value,
      });
    }

    const keys = new Map<
      number,
      Array<{ from: string; table: string; to: string | null; on_update: string; on_delete: string }>
    >();
    for (const key of db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as Array<{
      id: number;
      from: string;
      table: string;
      to: string | null;
      on_update: string;
      on_delete: string;
    }>) {
      keys.set(key.id, [...(keys.get(key.id) ?? []), key]);
    }
    const foreignKeys = [...keys.values()]
      .map((parts) => {
        const [first] = parts;
        return `${parts.map((part) => part.from).join(',')}->${first?.table}(${parts.map((part) => part.to ?? '').join(',')}) on delete ${first?.on_delete} on update ${first?.on_update}`;
      })
      .sort()
      .join('; ');

    const uniques = (db.prepare(`PRAGMA index_list(${quoted})`).all() as Array<{ name: string; origin: string }>)
      .filter((index) => index.origin === 'u')
      .map((index) =>
        (db.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all() as Array<{ name: string }>)
          .map((column) => column.name)
          .join(',')
      )
      .sort()
      .join('; ');

    const indexes = new Map<string, { sql: string; normalized: string }>();
    for (const index of db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
      .all(name) as Array<{ name: string; sql: string }>) {
      indexes.set(index.name, { sql: index.sql, normalized: normalizeSql(index.sql) });
    }

    tables.set(name, {
      sql,
      columns,
      checks: checkClauses(sql).join('; '),
      foreignKeys,
      uniques,
      indexes,
    });
  }
  return tables;
}

/** The `CHECK (...)` clauses of a `CREATE TABLE` statement, normalized and sorted. */
function checkClauses(sql: string): string[] {
  const clauses: string[] = [];
  for (const match of sql.matchAll(/\bCHECK\s*\(/gi)) {
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < sql.length; end += 1) {
      if (sql[end] === '(') depth += 1;
      else if (sql[end] === ')' && --depth === 0) break;
    }
    clauses.push(normalizeSql(sql.slice(match.index, end + 1)));
  }
  return clauses.sort();
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, '').replaceAll('"', '').toLowerCase();
}
