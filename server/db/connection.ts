import Database from 'better-sqlite3';
import { type SqlValue, type ReplicatedSqlStatement } from './types.js';
import path from 'path';
import fs from 'fs';

type Db = Database.Database;

type PreparedStatement = Database.Statement<SqlValue[], unknown>;

export const DATA_DIR = process.env.DATA_PATH
  ? path.resolve(process.env.DATA_PATH, 'data')
  : path.resolve(process.cwd(), 'data');

export const DB_FILE = path.join(DATA_DIR, 'app.db');

const APP_DATA_TABLE_PATTERN =
  /\b(?:runners|labels|runner_labels|queue_entries|race_state|laps|race_events|temporary_teams|temporary_team_members)\b/i;

let database: Db | null = null;

export const statementCache = new Map<string, PreparedStatement>();

let appDataRevision = 0;

let writeCapture: ReplicatedSqlStatement[] | null = null;

export function getDb(): Db {
  if (!database) throw new Error('database not initialized');
  return database;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

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

export function isReplicatedMutation(sql: string): boolean {
  const normalized = sql.trim().toLowerCase();
  return /^(insert|update|delete|replace)\b/.test(normalized)
    && !/\b(?:replication_operations|replication_peer_progress|replication_conflicts)\b/.test(
      normalized
    );
}

export function all<T>(sql: string, params: SqlValue[] = []): T[] {
  return statement(sql).all(...params) as T[];
}

export function one<T>(sql: string, params: SqlValue[] = []): T | null {
  return statement(sql).get(...params) as T | undefined ?? null;
}

function statement(sql: string): PreparedStatement {
  const cached = statementCache.get(sql);
  if (cached) return cached;
  const prepared = getDb().prepare(sql);
  statementCache.set(sql, prepared);
  return prepared;
}

export function transaction<T>(callback: () => T): T {
  return getDb().transaction(callback)();
}

export function markAppDataChanged(): void {
  appDataRevision += 1;
}

export function isCapturingWrite(): boolean {
  return writeCapture !== null;
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

export function getAppDataRevision(): number {
  return appDataRevision;
}

export function openDatabase(): Db {
  ensureDataDir();
  statementCache.clear();
  if (database) database.close();
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
  if (!database) return;
  database.close();
  database = null;
}

export async function backupDatabase(destination: string): Promise<void> {
  await getDb().backup(destination);
}
