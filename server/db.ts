import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, openDatabase, statementCache } from './db/connection.js';
import { DATABASE_SCHEMA_VERSION, createSchema, migrateSchema, seedDefaultLabels } from './db/schema.js';
import { getSetting } from './db/settings.js';
import { syncTemporaryTeamRows } from './db/teams.js';
import { ensureReplicationIdentity } from './db/replication-state.js';

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
  createSchema();
  // Keep a copy of databases from before the local-first replication rewrite (schema 7).
  if (storedSchemaVersion > 0 && storedSchemaVersion < 7) {
    const backupPath = path.join(DATA_DIR, 'app.pre-local-first-v2.sqlite');
    if (!fs.existsSync(backupPath)) await database.backup(backupPath);
  }
  migrateSchema();
  statementCache.clear();
  seedDefaultLabels();
  syncTemporaryTeamRows();
  ensureReplicationIdentity();
}

export type { ReplicationOperation, ReplicationIdentity, ReplicationConflict, ReplicationCheckpoint } from './db/types.js';
export { getAppDataRevision, closeDb, backupDatabase } from './db/connection.js';
export { databaseReadiness, databaseStorageStatus, compactDatabaseIfSafe } from './db/storage.js';
export { getAppSettings, setPublicRecordMode } from './db/settings.js';
export { ensureReplicationIdentity, getReplicationVector } from './db/replication-state.js';
export {
  assertOrClaimTimingController,
  assignTimingController,
  getTimingControllerHostId,
  getTimingControllerGeneration,
  commitReplicatedWrite,
  getReplicationOperationsMissing,
  getAllReplicationOperations,
  getReplicationOperation,
  getOpenReplicationConflictCount,
  getReplicationConflicts,
  getDeadLetterCount,
  prepareReplicationConflictChoice,
  finalizeReplicationConflict,
  getPendingReplicationOperationCount,
  acknowledgeReplicationVector,
  applyRemoteReplicationOperations,
  installReplicationBootstrap,
} from './db/replication.js';
export { ensureReplicationCheckpoint } from './db/checkpoint.js';
export { getLabels, findLabelByName, createLabel, updateLabel, deleteLabel } from './db/labels.js';
export {
  getTemporaryTeams,
  getTemporaryTeam,
  setTemporaryTeamMembers,
  setTemporaryTeamActive,
  setTemporaryTeamSchedule,
} from './db/teams.js';
export { getAllRunners, getRunnerById, getRunnersByIds } from './db/runner-queries.js';
export { insertRunner, updateRunner, upsertRunnerFromImport, deleteRunner } from './db/runners.js';
export {
  hideRunnerInQueue,
  unhideRunnerInQueue,
  updateRunnerStatus,
  runnerStatusChangeError,
  updateWaitingOrder,
} from './db/queue.js';
export { getRaceState } from './db/race-state.js';
export {
  getAllLaps,
  getRecentLaps,
  getLapsForRunner,
  getLapById,
  getAllRaceEvents,
  getRecentRaceEvents,
} from './db/history.js';
export { createBurgieGepaktEvent, performHandoff, undoLastHandoff, finishRace } from './db/timing.js';
export { applySnapshot } from './db/snapshot.js';
