import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DamagedDatabase } from '../shared/schemas.js';
import { DATA_DIR, DB_FILE, backupDatabase, closeDb, openDatabase } from './db/connection.js';
import { DATABASE_SCHEMA_VERSION, createSchema, migrateSchema, seedDefaultLabels } from './db/schema.js';
import { schemaProblems } from './db/schema-check.js';
import { quickCheck } from './db/sqlite-file.js';
import { DAMAGED_DATABASE_SETTING, getSetting, hostIdentity, setLocalSetting } from './db/settings.js';
import { syncTemporaryTeamRows } from './db/teams.js';

/** The first 4.0 schema. Older databases hold only earlier years' events and are put aside, not converted. */
const FIRST_KEPT_SCHEMA_VERSION = 13;

/** SQLite's primary result codes for a damaged file and for a file that is no database at all. */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

export async function initDb(): Promise<void> {
  const opened = openUndamagedDatabase();
  let database = opened.database;
  const hasTables = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table'").get());
  const hasSettingsTable = Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()
  );
  const storedSchemaVersion = hasSettingsTable ? Number(getSetting('schema_version') || 0) : 0;
  if (storedSchemaVersion > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `database schema ${storedSchemaVersion} is newer than this Apolloon release (${DATABASE_SCHEMA_VERSION})`
    );
  }
  const retired = hasTables && storedSchemaVersion < FIRST_KEPT_SCHEMA_VERSION;
  if (retired) {
    const retiredPath = putDatabaseAside('retired');
    console.warn(
      `Put aside a database from before 4.0 (schema ${storedSchemaVersion}) as ${path.basename(retiredPath)}; starting empty.`
    );
    database = openDatabase();
  }
  createSchema();
  // Keep a copy before rebuilding tables of a database whose structure is out of date. A failed
  // repair changes nothing, so the restarts after it keep the first copy of the day.
  if (schemaProblems(database).some((problem) => problem.kind === 'table')) {
    const backupPath = path.join(DATA_DIR, `app.pre-repair-${new Date().toISOString().slice(0, 10)}.sqlite`);
    if (!fs.existsSync(backupPath)) await backupDatabase(backupPath);
  }
  migrateSchema();
  // Only a new database gets the built-in labels; in an existing one they are event data.
  if (!hasTables || retired) seedDefaultLabels();
  if (opened.damaged) setLocalSetting(DAMAGED_DATABASE_SETTING, JSON.stringify(opened.damaged));
  syncTemporaryTeamRows();
  hostIdentity();
}

/**
 * Opens the database. A file SQLite cannot read (a power cut or disk error damaged it) is put
 * aside untouched and an empty database opens in its place, so the laptop still starts and can
 * link to the group again or restore one of its backups.
 */
function openUndamagedDatabase(): { database: DatabaseSync; damaged: DamagedDatabase | null } {
  const problem = damageIn(DB_FILE);
  if (!problem) return { database: openDatabase(), damaged: null };
  let damagedPath;
  try {
    damagedPath = putDatabaseAside('damaged');
  } catch (error) {
    throw new Error(`database is damaged (${problem}) and could not be put aside: ${String(error)}`, {
      cause: error,
    });
  }
  console.warn(`Put aside a damaged database (${problem}) as ${path.basename(damagedPath)}; starting empty.`);
  return { database: openDatabase(), damaged: { fileName: path.basename(damagedPath), putAsideAt: Date.now() } };
}

/**
 * What `PRAGMA quick_check` or opening found wrong with the file, or null. Read-only, so a
 * damaged file and its write-ahead log stay as they are: a normal connection would switch the
 * journal mode and fold the log into the file when it closes.
 */
function damageIn(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  let probe: DatabaseSync | undefined;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    const check = quickCheck(probe);
    return check === 'ok' ? null : check;
  } catch (error) {
    if (!isDamagedDatabaseError(error)) throw error;
    return error instanceof Error ? error.message : String(error);
  } finally {
    probe?.close();
  }
}

function isDamagedDatabaseError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && [SQLITE_CORRUPT, SQLITE_NOTADB].includes(code & 0xff);
}

/** Moves the database file and its write-ahead log aside, untouched; returns the new path. */
function putDatabaseAside(kind: 'retired' | 'damaged'): string {
  closeDb();
  const asidePath = path.join(DATA_DIR, `app.${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  fs.renameSync(DB_FILE, asidePath);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${DB_FILE}${suffix}`)) fs.renameSync(`${DB_FILE}${suffix}`, `${asidePath}${suffix}`);
  }
  return asidePath;
}

export { getAppDataRevision, markAppDataChanged, onAppDataChanged, closeDb, backupDatabase } from './db/connection.js';
export { databaseReadiness, databaseFileBytes } from './db/storage.js';
export {
  getAppSettings,
  setPublicRecordMode,
  hostIdentity,
  getSetting,
  setLocalSetting,
  damagedDatabase,
} from './db/settings.js';
export {
  recordWrite,
  getClusterEpoch,
  getLogHead,
  hasEventChanges,
  getLogEntryId,
  getLogEntriesAfter,
  canContinueFrom,
  applyLogEntries,
  appendFromLeader,
  serializeDatabase,
  installDatabaseImage,
  replicationLogEntrySchema,
} from './db/replication.js';
export type { ReplicationLogEntry } from './db/types.js';
export { DATABASE_SCHEMA_VERSION } from './db/schema.js';
export { schemaProblems } from './db/schema-check.js';
export {
  getClusterMembers,
  saveClusterMember,
  removeClusterMember,
  keepOnlyClusterMember,
  getAutoLinks,
  saveAutoLink,
  getUnreachableMembers,
  setUnreachableMembers,
  getRemovedMembers,
  setRemovedMembers,
  type AutoLink,
  type ClusterMember,
} from './db/members.js';
export { findForwardedWrite, saveForwardedWrite, touchForwardedWrite } from './db/forwarded-writes.js';
export {
  getLabels,
  findLabelByName,
  createLabel,
  updateLabel,
  deleteLabel,
  saveLabelImage,
  getLabelImage,
} from './db/labels.js';
export {
  getTemporaryTeams,
  getTemporaryTeam,
  setTemporaryTeamMembers,
  setTemporaryTeamActive,
  setTemporaryTeamSchedule,
  activeTemporaryTeamsKey,
} from './db/teams.js';
export { countRunners, getAllRunners, getRunnerById, getRunnerRegistrations } from './db/runner-queries.js';
export { insertRunner, updateRunner, upsertRunnerFromImport, deleteRunner } from './db/runners.js';
export { hideRunnerInQueue, unhideRunnerInQueue, updateRunnerStatus, updateWaitingOrder } from './db/queue.js';
export { getRaceState, raceProgress } from './db/race-state.js';
export {
  getAllLaps,
  getLapById,
  getRecentLaps,
  getLapsForRunner,
  getAllRaceEvents,
  getRecentRaceEvents,
} from './db/history.js';
export { deleteLap, moveLap, splitLap } from './db/lap-corrections.js';
export {
  createBurgieGepaktEvent,
  performHandoff,
  lapsToUndo,
  undoLastHandoff,
  finishRace,
  canUndoFinish,
} from './db/timing.js';
export { getActivity, logActivity } from './db/activity.js';
export { previewBackup, readRestoreData, replaceEventData, restoreDataSchema } from './db/restore.js';
