import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getDb, openDatabase } from './db/connection.js';
import { DATABASE_SCHEMA_VERSION, createSchema, migrateSchema, seedDefaultLabels } from './db/schema.js';
import { getSetting, hostIdentity } from './db/settings.js';
import { syncTemporaryTeamRows } from './db/teams.js';

export async function initDb(): Promise<void> {
  const database = openDatabase();
  const hasSettingsTable = Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()
  );
  const storedSchemaVersion = hasSettingsTable ? Number(getSetting('schema_version') || 0) : 0;
  if (storedSchemaVersion > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `database schema ${storedSchemaVersion} is newer than this Apolloon release (${DATABASE_SCHEMA_VERSION})`
    );
  }
  // Keep a copy from before the schema 13 replication rewrite; it also drops the old operation log.
  const upgradesReplication = storedSchemaVersion > 0 && storedSchemaVersion < 13;
  if (upgradesReplication) {
    const backupPath = path.join(DATA_DIR, `app.pre-schema-13.sqlite`);
    if (!fs.existsSync(backupPath)) await database.backup(backupPath);
  }
  createSchema();
  migrateSchema();
  if (upgradesReplication) getDb().exec('VACUUM');
  seedDefaultLabels();
  syncTemporaryTeamRows();
  hostIdentity();
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
export { getClusterMembers, saveClusterMember, keepOnlyClusterMember, type ClusterMember } from './db/members.js';
export { findForwardedWrite, saveForwardedWrite, touchForwardedWrite } from './db/forwarded-writes.js';
export { getLabels, findLabelByName, createLabel, updateLabel, deleteLabel } from './db/labels.js';
export {
  getTemporaryTeams,
  getTemporaryTeam,
  setTemporaryTeamMembers,
  setTemporaryTeamActive,
  setTemporaryTeamSchedule,
  activeTemporaryTeamsKey,
} from './db/teams.js';
export { getAllRunners, getRunnerById, getRunnerRegistrations } from './db/runner-queries.js';
export { insertRunner, updateRunner, upsertRunnerFromImport, deleteRunner } from './db/runners.js';
export { hideRunnerInQueue, unhideRunnerInQueue, updateRunnerStatus, updateWaitingOrder } from './db/queue.js';
export { getRaceState } from './db/race-state.js';
export { getAllLaps, getRecentLaps, getLapsForRunner, getAllRaceEvents, getRecentRaceEvents } from './db/history.js';
export { createBurgieGepaktEvent, performHandoff, undoLastHandoff, finishRace } from './db/timing.js';
