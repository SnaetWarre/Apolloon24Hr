import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { BackupPreview } from '../../shared/schemas.js';
import { all, run } from './connection.js';
import { schemaProblems } from './schema-check.js';
import { REPLICATED_SETTING_KEYS } from './settings.js';
import { quickCheck } from './sqlite-file.js';

/**
 * The event tables a backup brings back, parents first. Which laptops form the group,
 * the replication log and the activity log stay as they are: restoring is itself a
 * change the group makes together, and the activity log keeps saying who did it.
 */
export const RESTORED_TABLES = [
  'label_images',
  'labels',
  'runners',
  'runner_labels',
  'race_state',
  'laps',
  'handoff_history',
  'race_events',
  'temporary_teams',
  'temporary_team_members',
] as const;

const sqlValue = z.union([z.string(), z.number().finite(), z.null()]);

export const restoreDataSchema = z.object({
  fileName: z.string().min(1).max(200),
  backupCreatedAt: z.number().int().nonnegative(),
  tables: z.record(z.enum(RESTORED_TABLES), z.array(z.record(z.string(), sqlValue)).max(500_000)),
  settings: z.array(z.object({ key: z.string(), value: z.string() })).max(100),
});

export type RestoreData = z.infer<typeof restoreDataSchema>;

/** Opens a backup read-only after checking it is intact and has the current tables. */
function openBackup(filePath: string): DatabaseSync {
  const backup = new DatabaseSync(filePath, { readOnly: true });
  try {
    const check = quickCheck(backup);
    if (check !== 'ok') throw new Error(`Deze backup is beschadigd (${check}).`);
    const restored = new Set<string>(RESTORED_TABLES);
    const problems = schemaProblems(backup).filter(
      (problem) => problem.kind === 'table' && restored.has(problem.table)
    );
    if (problems.length) {
      throw new Error(
        `Deze backup komt van een andere versie van Apolloon (${problems.map((problem) => problem.detail).join('; ')}).`
      );
    }
    return backup;
  } catch (error) {
    backup.close();
    throw error;
  }
}

export function previewBackup(filePath: string, fileName: string, createdAt: number): BackupPreview {
  const backup = openBackup(filePath);
  try {
    const count = (table: string) => (backup.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
    const race = backup
      .prepare('SELECT race_started_at AS startedAt, race_finished_at AS finishedAt FROM race_state')
      .get() as { startedAt: number | null; finishedAt: number | null } | undefined;
    const lastLap = backup.prepare('SELECT MAX(finished_at) AS at FROM laps').get() as { at: number | null };
    return {
      fileName,
      createdAt,
      runners: count('runners'),
      laps: count('laps'),
      lastLapAt: lastLap.at,
      raceStartedAt: race?.startedAt ?? null,
      raceFinishedAt: race?.finishedAt ?? null,
    };
  } finally {
    backup.close();
  }
}

/** Everything a restore writes, read from the backup on the laptop that holds it. */
export function readRestoreData(filePath: string, fileName: string, backupCreatedAt: number): RestoreData {
  const backup = openBackup(filePath);
  try {
    const tables = Object.fromEntries(
      RESTORED_TABLES.map((table) => [table, backup.prepare(`SELECT * FROM "${table}"`).all()])
    ) as RestoreData['tables'];
    const keys = REPLICATED_SETTING_KEYS.map(() => '?').join(', ');
    const settings = backup
      .prepare(`SELECT key, value FROM settings WHERE key IN (${keys})`)
      .all(...REPLICATED_SETTING_KEYS) as Array<{ key: string; value: string }>;
    return { fileName, backupCreatedAt, tables, settings };
  } finally {
    backup.close();
  }
}

/**
 * Replaces the event data with the backup's, as one replicated write: every statement is
 * captured, so the other laptops end up with exactly the same data. Only columns this
 * version knows are written, so the table and column names in the SQL never come from input.
 */
export function replaceEventData(data: RestoreData): { runners: number; laps: number } {
  for (const table of [...RESTORED_TABLES].reverse()) run(`DELETE FROM "${table}"`);
  for (const table of RESTORED_TABLES) {
    const columns = all<{ name: string }>(`PRAGMA table_info("${table}")`).map((column) => column.name);
    const sql = `INSERT INTO "${table}" (${columns.map((name) => `"${name}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    for (const row of data.tables[table])
      run(
        sql,
        columns.map((name) => row[name] ?? null)
      );
  }
  for (const { key, value } of data.settings) {
    if (REPLICATED_SETTING_KEYS.includes(key))
      run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, value]);
  }
  return { runners: data.tables.runners.length, laps: data.tables.laps.length };
}
