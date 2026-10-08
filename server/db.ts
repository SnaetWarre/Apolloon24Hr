import fs from 'node:fs';
import path from 'node:path';
import { type DatabaseSync } from 'node:sqlite';
import { DATA_DIR, DB_FILE, backupDatabase, closeDb, openDatabase } from './db/connection.js';
import { DATABASE_SCHEMA_VERSION, createSchema, migrateSchema, seedDefaultLabels } from './db/schema.js';
import { schemaProblems } from './db/schema-check.js';
import { getSetting, hostIdentity } from './db/settings.js';
import { syncTemporaryTeamRows } from './db/teams.js';

/** The first 4.0 schema. Older databases hold only earlier years' events and are put aside, not converted. */
const FIRST_KEPT_SCHEMA_VERSION = 13;

export async function initDb(): Promise<void> {
  let database = openDatabase();
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
  if (retired) database = retireDatabase(storedSchemaVersion);
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
  syncTemporaryTeamRows();
  hostIdentity();
}

/** Moves the database file aside, untouched, and opens an empty one in its place. */
function retireDatabase(schemaVersion: number): DatabaseSync {
  closeDb();
  const retiredPath = path.join(DATA_DIR, `app.retired-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  fs.renameSync(DB_FILE, retiredPath);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${DB_FILE}${suffix}`)) fs.renameSync(`${DB_FILE}${suffix}`, `${retiredPath}${suffix}`);
  }
  console.warn(
    `Put aside a database from before 4.0 (schema ${schemaVersion}) as ${path.basename(retiredPath)}; starting empty.`
  );
  return openDatabase();
}

export { getAppDataRevision, markAppDataChanged, onAppDataChanged, closeDb, backupDatabase } from './db/connection.js';
export { databaseReadiness, databaseFileBytes } from './db/storage.js';
export { getAppSettings, setPublicRecordMode, hostIdentity, getSetting, setLocalSetting } from './db/settings.js';
export {
  recordWrite,
  getClusterEpoch,
  getLogHead,
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
export { getRaceState } from './db/race-state.js';
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
