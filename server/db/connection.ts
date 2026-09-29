import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../env.js';
import { type SqlValue, type ReplicatedSqlStatement } from './types.js';

type PreparedStatement = Database.Statement<SqlValue[], unknown>;

export const DATA_DIR = path.join(DATA_ROOT, 'data');

export const DB_FILE = path.join(DATA_DIR, 'app.db');

const APP_DATA_TABLE_PATTERN =
  /\b(?:runners|labels|runner_labels|queue_entries|race_state|laps|race_events|temporary_teams|temporary_team_members)\b/i;

const REPLICATION_TABLE_PATTERN = /\b(?:replication_operations|replication_peer_progress|replication_conflicts)\b/;

let database: Database.Database | null = null;

export const statementCache = new Map<string, PreparedStatement>();

let appDataRevision = 0;

let writeCapture: ReplicatedSqlStatement[] | null = null;

export function getDb(): Database.Database {
  if (!database) throw new Error('database not initialized');
  return database;
}

function statement(sql: string): PreparedStatement {
  let prepared = statementCache.get(sql);
  if (!prepared) {
    prepared = getDb().prepare(sql);
    statementCache.set(sql, prepared);
  }
  return prepared;
}

/** Application write: recorded into the active replicated command and bumps the data revision. */
export function run(sql: string, params: SqlValue[] = []): Database.RunResult {
  if (writeCapture && isReplicatedMutation(sql)) {
    writeCapture.push({ sql, params: [...params] });
  }
  const result = statement(sql).run(...params);
  if (result.changes > 0 && APP_DATA_TABLE_PATTERN.test(sql)) {
    appDataRevision += 1;
  }
  return result;
}

/**
 * Write that must never be captured into a replicated command: replication
 * bookkeeping, checkpoint restores, and replaying statements received from peers.
 */
export function runUncaptured(sql: string, params: SqlValue[] = []): Database.RunResult {
  return getDb()
    .prepare(sql)
    .run(...params);
}

export function isReplicatedMutation(sql: string): boolean {
  const normalized = sql.trim().toLowerCase();
  return /^(insert|update|delete|replace)\b/.test(normalized) && !REPLICATION_TABLE_PATTERN.test(normalized);
}

export function all<T>(sql: string, params: SqlValue[] = []): T[] {
  return statement(sql).all(...params) as T[];
}

export function one<T>(sql: string, params: SqlValue[] = []): T | null {
  return (statement(sql).get(...params) as T | undefined) ?? null;
}

export function transaction<T>(callback: () => T): T {
  return getDb().transaction(callback)();
}

export function markAppDataChanged(): void {
  appDataRevision += 1;
}

export function getAppDataRevision(): number {
  return appDataRevision;
}

export function captureWrite<T>(action: () => T): { result: T; statements: ReplicatedSqlStatement[] } {
  if (writeCapture) throw new Error('nested replicated write is not supported');
  const statements: ReplicatedSqlStatement[] = [];
  writeCapture = statements;
  try {
    return { result: action(), statements };
  } finally {
    writeCapture = null;
  }
}

export function openDatabase(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  closeDb();
  database = new Database(DB_FILE);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma(process.env.NODE_ENV === 'test' ? 'synchronous = NORMAL' : 'synchronous = FULL');
  database.pragma('busy_timeout = 5000');
  database.pragma('cache_size = -8192');
  database.pragma('temp_store = MEMORY');
  database.pragma('journal_size_limit = 16777216');
  return database;
}

export function closeDb(): void {
  statementCache.clear();
  database?.close();
  database = null;
}

export async function backupDatabase(destination: string): Promise<void> {
  await getDb().backup(destination);
}
