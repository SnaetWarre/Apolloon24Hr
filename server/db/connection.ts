import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from '../env.js';
import { type ReplicatedStatement, type SqlValue } from './types.js';

type PreparedStatement = Database.Statement<SqlValue[], unknown>;

export const DATA_DIR = path.join(DATA_ROOT, 'data');

export const DB_FILE = path.join(DATA_DIR, 'app.db');

let database: Database.Database | null = null;

const statementCache = new Map<string, PreparedStatement>();

let appDataRevision = 0;

const revisionListeners = new Set<(revision: number) => void>();

let writeCapture: ReplicatedStatement[] | null = null;

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

/** Application write: recorded into the active replicated write so the other laptops can replay it. */
export function run(sql: string, params: SqlValue[] = []): Database.RunResult {
  writeCapture?.push({ sql, params: [...params] });
  return statement(sql).run(...params);
}

/** Write that is never replicated: host-local settings, the log itself, and replaying the leader's statements. */
export function runUncaptured(sql: string, params: SqlValue[] = []): Database.RunResult {
  return statement(sql).run(...params);
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

export function captureWrite<T>(action: () => T): {
  result: T;
  statements: ReplicatedStatement[];
} {
  if (writeCapture) throw new Error('nested replicated write is not supported');
  const statements: ReplicatedStatement[] = [];
  writeCapture = statements;
  try {
    return { result: action(), statements };
  } finally {
    writeCapture = null;
  }
}

/** Call only after the change has been committed: listeners publish it to clients. */
export function markAppDataChanged(): void {
  appDataRevision += 1;
  for (const listener of revisionListeners) listener(appDataRevision);
}

export function getAppDataRevision(): number {
  return appDataRevision;
}

export function onAppDataChanged(listener: (revision: number) => void): () => void {
  revisionListeners.add(listener);
  return () => revisionListeners.delete(listener);
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
