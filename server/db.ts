import path from 'path';
import fs from 'fs';
import { openDatabase, DATA_DIR, statementCache } from './db/connection.js';
import { DATABASE_SCHEMA_VERSION, createSchema, migrateSchema, seedDefaultLabels } from './db/schema.js';
import { getSetting } from './db/settings.js';
import { syncTemporaryTeamRows } from './db/teams.js';
import { ensureReplicationIdentity } from './db/replication-state.js';

export async function initDb(): Promise<void> {
  const database = openDatabase();
  const hasSettingsTable = Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
      .get()
  );
  const storedSchemaVersion = hasSettingsTable
    ? (database
        .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
        .pluck()
        .get() as string | undefined)
    : undefined;
  if (Number(storedSchemaVersion || 0) > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `database schema ${storedSchemaVersion} is newer than this Apolloon release (${DATABASE_SCHEMA_VERSION})`
    );
  }
  createSchema();
  const previousVersion = Number(getSetting('schema_version') || 0);
  if (previousVersion > 0 && previousVersion < 7) {
    const backupPath = path.join(DATA_DIR, `app.pre-local-first-v2.sqlite`);
    if (!fs.existsSync(backupPath)) {
      await database.backup(backupPath);
    }
  }
  migrateSchema();
  statementCache.clear();
  seedDefaultLabels();
  syncTemporaryTeamRows();
  ensureReplicationIdentity();
}

export { DATABASE_SCHEMA_VERSION } from './db/schema.js';
export { type ReplicatedSqlStatement, type ReplicationOperation, type ReplicationIdentity, type ReplicationConflict, type ReplicationCheckpoint } from './db/types.js';
export { getAppDataRevision, closeDb, backupDatabase } from './db/connection.js';
export { databaseReadiness, databaseStorageStatus, compactDatabaseIfSafe } from './db/storage.js';
export { getSetting, setSetting, getAppSettings, setPublicRecordMode, ensureHostId } from './db/settings.js';
export { ensureReplicationIdentity, getReplicationVector } from './db/replication-state.js';
export { assertOrClaimTimingController, claimTimingController, assignTimingController, getTimingControllerGeneration, commitReplicatedWrite, getReplicationOperationsMissing, getAllReplicationOperations, getReplicationOperation, getOpenReplicationConflictCount, getReplicationConflicts, getDeadLetterOperations, getDeadLetterCount, prepareReplicationConflictChoice, finalizeReplicationConflict, getPendingReplicationOperationCount, acknowledgeReplicationVector, applyRemoteReplicationOperations, installReplicationBootstrap } from './db/replication.js';
export { getReplicationCheckpoint } from './db/checkpoint.js';
export { getLabels, findLabelByName, ensureLabel, createLabel, updateLabel, deleteLabel } from './db/labels.js';
export { getTemporaryTeams, setTemporaryTeamMembers, setTemporaryTeamActive, setTemporaryTeamSchedule } from './db/teams.js';
export { getAllRunners, getRunnerById, getRunnersByIds } from './db/runner-queries.js';
export { setRunnerLabels, insertRunner, updateRunner, upsertRunnerFromImport, deleteRunner } from './db/runners.js';
export { hideRunnerInQueue, unhideRunnerInQueue, updateRunnerStatus, runnerStatusChangeError, updateWaitingOrder, getMaxQueueIndex } from './db/queue.js';
export { getRaceState, getAllLaps, getRecentLaps, getLapsForRunner, getLapById, getAllRaceEvents, getRecentRaceEvents, getRaceEventById } from './db/history.js';
export { createBurgieGepaktEvent, performHandoff, undoLastHandoff, finishRace } from './db/timing.js';
export { applySnapshot } from './db/snapshot.js';
