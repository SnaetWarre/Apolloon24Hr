import fs from 'node:fs';
import { DB_FILE, getAppDataRevision, getDb } from './connection.js';
import { getSetting } from './settings.js';

export function databaseReadiness(): {
  ready: true;
  schemaVersion: number;
  revision: number;
} {
  const probe = getDb().prepare('SELECT 1 AS ready').get() as { ready: number } | undefined;
  if (probe?.ready !== 1) throw new Error('database readiness probe failed');
  return {
    ready: true,
    schemaVersion: Number(getSetting('schema_version') || 0),
    revision: getAppDataRevision(),
  };
}

/** The database on disk, including changes still in the write-ahead log. */
export function databaseFileBytes(): number {
  return [DB_FILE, `${DB_FILE}-wal`].reduce(
    (total, file) => total + (fs.existsSync(file) ? fs.statSync(file).size : 0),
    0
  );
}
