import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// No app imports: the backup verification worker loads this on its own thread.

/** Opens a standalone database file that must already exist, such as a backup or a received image. */
export function openExistingDatabase(filePath: string): DatabaseSync {
  if (!fs.existsSync(filePath)) throw new Error(`database file does not exist: ${filePath}`);
  return new DatabaseSync(filePath);
}

/** `'ok'`, or the problems `PRAGMA quick_check` found. */
export function quickCheck(db: DatabaseSync): string {
  const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
  return rows.map((row) => row.quick_check).join('; ');
}
