import { gunzipSync, gzipSync } from 'node:zlib';
import { all, getDb, runUncaptured } from './connection.js';
import { getReplicationVector } from './replication-state.js';
import { deleteLocalSetting, getSetting, setLocalSetting } from './settings.js';
import { type ReplicationCheckpoint, type SqlValue } from './types.js';
import { parseLabelsJson, serializeHistoricalLabels } from './values.js';

export const REPLICATION_CHECKPOINT_KEY = 'replication_checkpoint_gzip_v1';

/** Uncompressed checkpoint key used before schema 9; only read by the migration. */
export const LEGACY_REPLICATION_CHECKPOINT_KEY = 'replication_checkpoint_json';

const REPLICATION_CHECKPOINT_PREFIX = 'gzip-base64-v1:';

const MAX_REPLICATION_CHECKPOINT_BYTES = 512 * 1_024 ** 2;

/** Application tables in foreign-key insert order; deletes run in reverse. */
const CHECKPOINT_TABLES = [
  'labels',
  'runners',
  'queue_entries',
  'runner_labels',
  'race_state',
  'laps',
  'handoff_history',
  'race_events',
  'temporary_teams',
  'temporary_team_members',
] as const;

const CHECKPOINT_SETTING_KEYS: readonly string[] = [
  'public_record_mode',
  'timing_controller_host_id',
  'timing_controller_generation',
];

export function compactStoredLapLabels(): void {
  const update = getDb().prepare('UPDATE laps SET labels_json = ? WHERE id = ?');
  for (const lap of all<{ id: string; labelsJson: string }>('SELECT id, labels_json AS labelsJson FROM laps')) {
    const compact = serializeHistoricalLabels(parseLabelsJson(lap.labelsJson));
    if (compact !== lap.labelsJson) update.run(compact, lap.id);
  }
}

function captureReplicationCheckpoint(): ReplicationCheckpoint {
  const tables: ReplicationCheckpoint['tables'] = {};
  for (const table of CHECKPOINT_TABLES) {
    tables[table] = getDb().prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, SqlValue>>;
  }
  const settings = Object.fromEntries(
    CHECKPOINT_SETTING_KEYS.flatMap((key) => {
      const value = getSetting(key);
      return value === null ? [] : [[key, value]];
    })
  );
  return { vector: getReplicationVector(), tables, settings };
}

/** Accepts the gzip-prefixed format and the plain JSON written before schema 9. */
export function decodeReplicationCheckpoint(stored: string): ReplicationCheckpoint {
  let serialized = stored;
  if (stored.startsWith(REPLICATION_CHECKPOINT_PREFIX)) {
    const encoded = stored.slice(REPLICATION_CHECKPOINT_PREFIX.length);
    if (!encoded || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) {
      throw new Error('replication checkpoint encoding is invalid');
    }
    serialized = gunzipSync(Buffer.from(encoded, 'base64'), {
      maxOutputLength: MAX_REPLICATION_CHECKPOINT_BYTES,
    }).toString('utf8');
  }
  const checkpoint = JSON.parse(serialized) as Partial<ReplicationCheckpoint> | null;
  const isRecord = (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!checkpoint || !isRecord(checkpoint.vector) || !isRecord(checkpoint.tables) || !isRecord(checkpoint.settings)) {
    throw new Error('replication checkpoint is invalid');
  }
  return checkpoint as ReplicationCheckpoint;
}

export function storeReplicationCheckpoint(checkpoint: ReplicationCheckpoint): void {
  const compressed = gzipSync(JSON.stringify(checkpoint), { level: 1 });
  setLocalSetting(REPLICATION_CHECKPOINT_KEY, `${REPLICATION_CHECKPOINT_PREFIX}${compressed.toString('base64')}`);
}

/**
 * The state the operation log is replayed on top of when concurrent histories
 * force a rebuild. Captured from the current data the first time it is needed.
 */
export function ensureReplicationCheckpoint(): ReplicationCheckpoint {
  const stored = getSetting(REPLICATION_CHECKPOINT_KEY);
  if (stored) return decodeReplicationCheckpoint(stored);
  const checkpoint = captureReplicationCheckpoint();
  storeReplicationCheckpoint(checkpoint);
  return checkpoint;
}

export function restoreReplicationCheckpoint(checkpoint: ReplicationCheckpoint): void {
  for (const table of [...CHECKPOINT_TABLES].reverse()) {
    runUncaptured(`DELETE FROM "${table}"`);
  }
  for (const table of CHECKPOINT_TABLES) {
    const allowedColumns = new Set(
      (getDb().prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((column) => column.name)
    );
    for (const row of checkpoint.tables[table] ?? []) {
      const columns = Object.keys(row).filter((column) => allowedColumns.has(column));
      if (!columns.length) continue;
      runUncaptured(
        `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((column) => row[column])
      );
    }
  }
  for (const key of CHECKPOINT_SETTING_KEYS) deleteLocalSetting(key);
  for (const [key, value] of Object.entries(checkpoint.settings)) {
    if (CHECKPOINT_SETTING_KEYS.includes(key)) setLocalSetting(key, value);
  }
}
