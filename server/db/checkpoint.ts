import { getDb, all } from './connection.js';
import { serializeHistoricalLabels, parseLabelsJson } from './values.js';
import { type ReplicationCheckpoint, type SqlValue } from './types.js';
import { getSetting, setReplicationSetting } from './settings.js';
import { getReplicationVector } from './replication-state.js';
import { gunzipSync, gzipSync } from 'node:zlib';

export const REPLICATION_CHECKPOINT_KEY = 'replication_checkpoint_gzip_v1';

export const LEGACY_REPLICATION_CHECKPOINT_KEY = 'replication_checkpoint_json';

const REPLICATION_CHECKPOINT_PREFIX = 'gzip-base64-v1:';

const MAX_REPLICATION_CHECKPOINT_BYTES = 512 * 1_024 ** 2;

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

const CHECKPOINT_DELETE_ORDER = [
  'handoff_history',
  'race_events',
  'laps',
  'temporary_team_members',
  'temporary_teams',
  'runner_labels',
  'race_state',
  'queue_entries',
  'runners',
  'labels',
] as const;

const CHECKPOINT_SETTING_KEYS = [
  'public_record_mode',
  'timing_controller_host_id',
  'timing_controller_generation',
] as const;

export function compactStoredLapLabels(): void {
  const update = getDb().prepare('UPDATE laps SET labels_json = ? WHERE id = ?');
  for (const lap of all<{ id: string; labelsJson: string }>(
    'SELECT id, labels_json AS labelsJson FROM laps'
  )) {
    const compact = serializeHistoricalLabels(parseLabelsJson(lap.labelsJson));
    if (compact !== lap.labelsJson) update.run(compact, lap.id);
  }
}

function captureReplicationCheckpoint(): ReplicationCheckpoint {
  const tables: ReplicationCheckpoint['tables'] = {};
  for (const table of CHECKPOINT_TABLES) {
    tables[table] = getDb().prepare(`SELECT * FROM "${table}"`).all() as Array<
      Record<string, SqlValue>
    >;
  }
  const settings = Object.fromEntries(
    CHECKPOINT_SETTING_KEYS.flatMap((key) => {
      const value = getSetting(key);
      return value === null ? [] : [[key, value]];
    })
  );
  return { vector: getReplicationVector(), tables, settings };
}

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
  const checkpoint = JSON.parse(serialized) as Partial<ReplicationCheckpoint>;
  if (
    !checkpoint ||
    typeof checkpoint !== 'object' ||
    !checkpoint.vector ||
    typeof checkpoint.vector !== 'object' ||
    Array.isArray(checkpoint.vector) ||
    !checkpoint.tables ||
    typeof checkpoint.tables !== 'object' ||
    Array.isArray(checkpoint.tables) ||
    !checkpoint.settings ||
    typeof checkpoint.settings !== 'object' ||
    Array.isArray(checkpoint.settings)
  ) {
    throw new Error('replication checkpoint is invalid');
  }
  return checkpoint as ReplicationCheckpoint;
}

function encodeReplicationCheckpoint(checkpoint: ReplicationCheckpoint): string {
  const compressed = gzipSync(JSON.stringify(checkpoint), { level: 1 });
  return `${REPLICATION_CHECKPOINT_PREFIX}${compressed.toString('base64')}`;
}

export function storeReplicationCheckpoint(checkpoint: ReplicationCheckpoint): void {
  setReplicationSetting(
    REPLICATION_CHECKPOINT_KEY,
    encodeReplicationCheckpoint(checkpoint)
  );
  getDb()
    .prepare('DELETE FROM settings WHERE key = ?')
    .run(LEGACY_REPLICATION_CHECKPOINT_KEY);
}

export function ensureReplicationCheckpoint(): ReplicationCheckpoint {
  const stored = getSetting(REPLICATION_CHECKPOINT_KEY);
  if (stored) return decodeReplicationCheckpoint(stored);
  const legacy = getSetting(LEGACY_REPLICATION_CHECKPOINT_KEY);
  if (legacy) {
    const checkpoint = decodeReplicationCheckpoint(legacy);
    storeReplicationCheckpoint(checkpoint);
    return checkpoint;
  }
  const checkpoint = captureReplicationCheckpoint();
  storeReplicationCheckpoint(checkpoint);
  return checkpoint;
}

export function getReplicationCheckpoint(): ReplicationCheckpoint {
  return ensureReplicationCheckpoint();
}

export function restoreReplicationCheckpoint(checkpoint: ReplicationCheckpoint): void {
  for (const table of CHECKPOINT_DELETE_ORDER) {
    getDb().prepare(`DELETE FROM "${table}"`).run();
  }
  for (const table of CHECKPOINT_TABLES) {
    const allowedColumns = new Set(
      (
        getDb().prepare(`PRAGMA table_info("${table}")`).all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );
    for (const row of checkpoint.tables[table] || []) {
      const columns = Object.keys(row).filter((column) => allowedColumns.has(column));
      if (!columns.length) continue;
      const quotedColumns = columns.map((column) => `"${column}"`).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      getDb()
        .prepare(`INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders})`)
        .run(...columns.map((column) => row[column]));
    }
  }
  for (const key of CHECKPOINT_SETTING_KEYS) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
  for (const [key, value] of Object.entries(checkpoint.settings || {})) {
    if ((CHECKPOINT_SETTING_KEYS as readonly string[]).includes(key)) {
      setReplicationSetting(key, value);
    }
  }
}
