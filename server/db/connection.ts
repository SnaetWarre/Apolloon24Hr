import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync, backup } from 'node:sqlite';
import { DATA_ROOT } from '../env.js';
import { type ReplicatedStatement, type SqlValue } from './types.js';

export type RunResult = { changes: number | bigint; lastInsertRowid: number | bigint };

export const DATA_DIR = path.join(DATA_ROOT, 'data');

export const DB_FILE = path.join(DATA_DIR, 'app.db');

let database: DatabaseSync | null = null;

const statementCache = new Map<string, StatementSync>();

/**
 * Starts at the clock instead of 0, so a restarted server never reuses a
 * revision a screen still holds: screens fetch only the changes since theirs.
 */
let appDataRevision = Date.now();

const revisionListeners = new Set<(revision: number) => void>();

let writeCapture: ReplicatedStatement[] | null = null;

export function getDb(): DatabaseSync {
  if (!database) throw new Error('database not initialized');
  return database;
}

function statement(sql: string): StatementSync {
  let prepared = statementCache.get(sql);
  if (!prepared) {
    prepared = getDb().prepare(sql);
    statementCache.set(sql, prepared);
  }
  return prepared;
}

/** Application write: recorded into the active replicated write so the other laptops can replay it. */
export function run(sql: string, params: SqlValue[] = []): RunResult {
  writeCapture?.push({ sql, params: [...params] });
  return statement(sql).run(...params);
}

/** Write that is never replicated: host-local settings, the log itself, and replaying the leader's statements. */
export function runUncaptured(sql: string, params: SqlValue[] = []): RunResult {
  return statement(sql).run(...params);
}

export function all<T>(sql: string, params: SqlValue[] = []): T[] {
  return statement(sql).all(...params) as T[];
}

export function one<T>(sql: string, params: SqlValue[] = []): T | null {
  return (statement(sql).get(...params) as T | undefined) ?? null;
}

const SAVEPOINT = '"apolloon_transaction"';

/**
 * Runs `callback` atomically. The outermost call commits or rolls back the
 * whole transaction; a nested call gets a savepoint, so its failure only
 * undoes its own changes and the caller may catch the error and continue.
 */
export function transaction<T>(callback: () => T): T {
  const db = getDb();
  const nested = db.isTransaction;
  const capturedBefore = writeCapture?.length ?? 0;
  db.exec(nested ? `SAVEPOINT ${SAVEPOINT}` : 'BEGIN');
  try {
    const result = callback();
    if (result instanceof Promise) throw new TypeError('transaction callback cannot return a promise');
    db.exec(nested ? `RELEASE ${SAVEPOINT}` : 'COMMIT');
    return result;
  } catch (error) {
    // SQLite may already have rolled back the whole transaction after some errors.
    if (db.isTransaction) db.exec(nested ? `ROLLBACK TO ${SAVEPOINT}; RELEASE ${SAVEPOINT}` : 'ROLLBACK');
    // Undone statements must not reach the replication log.
    if (writeCapture) writeCapture.length = capturedBefore;
    throw error;
  }
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

export function openDatabase(): DatabaseSync {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  closeDb();
  database = new DatabaseSync(DB_FILE);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = ${process.env.NODE_ENV === 'test' ? 'NORMAL' : 'FULL'};
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -8192;
    PRAGMA temp_store = MEMORY;
    PRAGMA journal_size_limit = 16777216;
  `);
  return database;
}

export function closeDb(): void {
  statementCache.clear();
  database?.close();
  database = null;
}

/** Online copy of the live database; writes may continue while it runs. */
export async function backupDatabase(destination: string): Promise<void> {
  await backup(getDb(), destination);
}
