import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  AppSettings,
  Label,
  LabelInput,
  LabelPatch,
  LapRecord,
  PublicRecordMode,
  RaceEvent,
  RaceEventType,
  RaceState,
  RegistrationSource,
  Runner,
  RunnerInput,
  RunnerPatch,
  RunnerStatus,
  AppSnapshot,
  TemporaryTeam,
} from '../shared/schemas.js';

type SqlValue = string | number | null;
type Db = Database.Database;
type PreparedStatement = Database.Statement<SqlValue[], unknown>;

const DATA_DIR = process.env.DATA_PATH
  ? path.resolve(process.env.DATA_PATH, 'data')
  : path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

const VALID_STATUSES = new Set<RunnerStatus>(['registered', 'warming_up', 'waiting', 'running', 'ran']);
const VALID_REGISTRATION_SOURCES = new Set<RegistrationSource>(['import', 'manual']);
const VALID_RACE_EVENT_TYPES = new Set<RaceEventType>(['burgie_gepakt']);
const VALID_PUBLIC_RECORD_MODES = new Set<PublicRecordMode>(['off', 'day', 'two_hour', 'hour']);
const DEFAULT_PUBLIC_RECORD_MODE: PublicRecordMode = 'day';
const TEMPORARY_TEAM_KIND = 'temporary_team';
const SCHEMA_VERSION = 7;
const MAX_REPLICATION_ORIGINS = 64;
const APP_DATA_TABLE_PATTERN =
  /\b(?:runners|labels|runner_labels|queue_entries|race_state|laps|race_events|temporary_teams|temporary_team_members)\b/i;

type DefaultLabel = LabelInput & { id: string };

const DEFAULT_LABEL_CREATED_AT = 1_700_000_000_000;
const DEFAULT_LABELS: DefaultLabel[] = [
  {
    id: '00000000-0000-5000-8000-000000000001',
    name: 'Speedteam White',
    color: '#e5e7eb',
    icon: 'SW',
    kind: 'speedteam',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 10,
  },
  {
    id: '00000000-0000-5000-8000-000000000002',
    name: 'Speedteam Blue',
    color: '#1d4ed8',
    icon: 'SB',
    kind: 'speedteam',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 20,
  },
  {
    id: '00000000-0000-5000-8000-000000000003',
    name: 'HILOK',
    color: '#16a34a',
    icon: 'HI',
    kind: 'zustervereniging',
    imageUrl: '/labels/hilok.png',
    targetLaps: null,
    sortOrder: 30,
  },
  {
    id: '00000000-0000-5000-8000-000000000004',
    name: 'Mesacosa',
    color: '#f97316',
    icon: 'ME',
    kind: 'zustervereniging',
    imageUrl: '/labels/mesacosa.jpg',
    targetLaps: null,
    sortOrder: 40,
  },
  {
    id: '00000000-0000-5000-8000-000000000005',
    name: 'Kinesia',
    color: '#7c3aed',
    icon: 'KI',
    kind: 'zustervereniging',
    imageUrl: '/labels/kinesia.png',
    targetLaps: null,
    sortOrder: 50,
  },
  {
    id: '00000000-0000-5000-8000-000000000006',
    name: '1ste jaar',
    color: '#2563eb',
    icon: '1J',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 60,
  },
  {
    id: '00000000-0000-5000-8000-000000000007',
    name: 'Anciens',
    color: '#64748b',
    icon: 'AN',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 70,
  },
  {
    id: '00000000-0000-5000-8000-000000000008',
    name: 'Dames',
    color: '#db2777',
    icon: 'DA',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 80,
  },
];

let database: Db | null = null;
const statementCache = new Map<string, PreparedStatement>();
let appDataRevision = 0;
let writeCapture: ReplicatedSqlStatement[] | null = null;

export type ReplicatedSqlStatement = {
  sql: string;
  params: SqlValue[];
};

export type ReplicationOperation = {
  id: string;
  clusterId: string;
  originHostId: string;
  originSeq: number;
  hlcWallMs: number;
  hlcCounter: number;
  type: string;
  payload: unknown;
  statements: ReplicatedSqlStatement[];
  result: unknown;
  raceBaseKey: string | null;
  status: 'accepted' | 'conflict' | 'rejected';
  checksum: string;
  createdAt: number;
  appliedAt: number;
};

export type ReplicationIdentity = {
  clusterId: string;
  clusterSecret: string;
  hostId: string;
};

export type ReplicationConflict = {
  id: string;
  kind: 'timing' | 'data';
  operationIds: string[];
  status: 'open' | 'resolved';
  resolutionOperationId: string | null;
  createdAt: number;
  resolvedAt: number | null;
  operations: Array<{
    id: string;
    originHostId: string;
    type: string;
    createdAt: number;
  }>;
};

export type ReplicationCheckpoint = {
  vector: Record<string, number>;
  tables: Record<string, Array<Record<string, SqlValue>>>;
  settings: Record<string, string>;
};

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

function getDb(): Db {
  if (!database) throw new Error('database not initialized');
  return database;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function run(sql: string, params: SqlValue[] = []): Database.RunResult {
  if (writeCapture && isReplicatedMutation(sql)) {
    writeCapture.push({ sql, params: [...params] });
  }
  const result = statement(sql).run(...params);
  if (result.changes > 0 && APP_DATA_TABLE_PATTERN.test(sql)) {
    appDataRevision += 1;
  }
  return result;
}

function isReplicatedMutation(sql: string): boolean {
  const normalized = sql.trim().toLowerCase();
  return /^(insert|update|delete|replace)\b/.test(normalized)
    && !/\b(?:replication_operations|replication_peer_progress|replication_conflicts)\b/.test(
      normalized
    );
}

function all<T>(sql: string, params: SqlValue[] = []): T[] {
  return statement(sql).all(...params) as T[];
}

function one<T>(sql: string, params: SqlValue[] = []): T | null {
  return statement(sql).get(...params) as T | undefined ?? null;
}

function statement(sql: string): PreparedStatement {
  const cached = statementCache.get(sql);
  if (cached) return cached;
  const prepared = getDb().prepare(sql);
  statementCache.set(sql, prepared);
  return prepared;
}

function transaction<T>(callback: () => T): T {
  return getDb().transaction(callback)();
}

export function getAppDataRevision(): number {
  return appDataRevision;
}

function cleanText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function cleanInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function cleanStatus(status: unknown): RunnerStatus {
  return VALID_STATUSES.has(status as RunnerStatus) ? (status as RunnerStatus) : 'registered';
}

function cleanRegistrationSource(source: unknown): RegistrationSource {
  return VALID_REGISTRATION_SOURCES.has(source as RegistrationSource)
    ? (source as RegistrationSource)
    : 'manual';
}

function parseLabelsJson(value: unknown): Label[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as Label[]) : [];
  } catch {
    return [];
  }
}

function normalizeName(name: unknown): string {
  return String(name || '').trim().toLowerCase();
}

function canonicalLabelName(name: unknown): string | null {
  const text = cleanText(name);
  const normalized = normalizeName(text);
  if (['1ste jaars', '1e jaar', '1e jaars', 'eerste jaar', 'eerste jaars'].includes(normalized)) {
    return '1ste jaar';
  }
  return text;
}

function createSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runners (
      id TEXT PRIMARY KEY,
      runner_number TEXT UNIQUE,
      name TEXT NOT NULL,
      target_laps INTEGER,
      historical_avg_ms INTEGER,
      historical_best_ms INTEGER,
      registration_source TEXT NOT NULL DEFAULT 'manual' CHECK(registration_source IN ('import','manual')),
      notes TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL,
      icon TEXT NOT NULL,
      kind TEXT NOT NULL,
      image_url TEXT,
      target_laps INTEGER,
      sort_order INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runner_labels (
      runner_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      PRIMARY KEY (runner_id, label_id),
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE,
      FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS queue_entries (
      runner_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('registered','warming_up','waiting','running','ran')),
      queue_index INTEGER,
      status_since INTEGER,
      hidden_at INTEGER,
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS race_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      active_runner_id TEXT,
      active_started_at INTEGER,
      race_started_at INTEGER,
      race_finished_at INTEGER,
      active_labels_json TEXT,
      FOREIGN KEY (active_runner_id) REFERENCES runners(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS laps (
      id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      lap_number INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS handoff_history (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS race_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('burgie_gepakt')),
      message TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      runner_id TEXT,
      runner_number TEXT,
      runner_name TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS temporary_teams (
      label_id TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 0,
      activated_at INTEGER,
      FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS temporary_team_members (
      team_label_id TEXT NOT NULL,
      runner_id TEXT NOT NULL UNIQUE,
      restore_label_ids_json TEXT,
      PRIMARY KEY (team_label_id, runner_id),
      FOREIGN KEY (team_label_id) REFERENCES temporary_teams(label_id) ON DELETE CASCADE,
      FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS replication_operations (
      id TEXT PRIMARY KEY,
      cluster_id TEXT NOT NULL,
      origin_host_id TEXT NOT NULL,
      origin_seq INTEGER NOT NULL,
      hlc_wall_ms INTEGER NOT NULL,
      hlc_counter INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      statements_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      race_base_key TEXT,
      status TEXT NOT NULL CHECK(status IN ('accepted','conflict','rejected')),
      checksum TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      UNIQUE(origin_host_id, origin_seq)
    );

    CREATE INDEX IF NOT EXISTS idx_replication_operations_order
      ON replication_operations(hlc_wall_ms, hlc_counter, origin_host_id, origin_seq);

    CREATE INDEX IF NOT EXISTS idx_replication_operations_race_base
      ON replication_operations(race_base_key)
      WHERE race_base_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS replication_peer_progress (
      peer_host_id TEXT NOT NULL,
      origin_host_id TEXT NOT NULL,
      acknowledged_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(peer_host_id, origin_host_id)
    );

    CREATE TABLE IF NOT EXISTS replication_conflicts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      operation_ids_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','resolved')),
      resolution_operation_id TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_laps_runner_finished
      ON laps(runner_id, finished_at DESC);

    CREATE INDEX IF NOT EXISTS idx_laps_finished
      ON laps(finished_at DESC);

    CREATE INDEX IF NOT EXISTS idx_queue_status_order
      ON queue_entries(status, queue_index, status_since);

    CREATE INDEX IF NOT EXISTS idx_race_events_occurred
      ON race_events(occurred_at DESC, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_runner_labels_label
      ON runner_labels(label_id, runner_id);
  `);

  run(
    `INSERT OR IGNORE INTO race_state (
      id,
      active_runner_id,
      active_started_at,
      race_started_at,
      race_finished_at
    ) VALUES (1, NULL, NULL, NULL, NULL)`
  );
}

function tableHasColumn(table: string, column: string): boolean {
  return all<{ name: string }>(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

function migrateSchema(): void {
  const previousVersion = Number(getSetting('schema_version') || 0);
  if (!tableHasColumn('race_state', 'active_labels_json')) {
    run('ALTER TABLE race_state ADD COLUMN active_labels_json TEXT');
  }
  if (!tableHasColumn('laps', 'labels_json')) {
    run("ALTER TABLE laps ADD COLUMN labels_json TEXT NOT NULL DEFAULT '[]'");
  }

  if (previousVersion < 5) {
    const labelsByRunner = getRunnerLabelsMap();
    for (const lap of all<{ id: string; runnerId: string }>('SELECT id, runner_id AS runnerId FROM laps')) {
      run('UPDATE laps SET labels_json = ? WHERE id = ?', [
        JSON.stringify(labelsByRunner.get(lap.runnerId) ?? []),
        lap.id,
      ]);
    }
    const active = one<{ runnerId: string | null }>(
      'SELECT active_runner_id AS runnerId FROM race_state WHERE id = 1'
    );
    if (active?.runnerId) {
      run('UPDATE race_state SET active_labels_json = ? WHERE id = 1', [
        JSON.stringify(labelsByRunner.get(active.runnerId) ?? []),
      ]);
    }
  }
  if (previousVersion < 6) {
    run('DROP INDEX IF EXISTS idx_laps_runner_finished');
    run(
      `CREATE INDEX idx_laps_runner_finished
       ON laps(runner_id, finished_at DESC, duration_ms)`
    );
  }
  setSetting('schema_version', String(SCHEMA_VERSION));
}

function seedDefaultLabels(): void {
  for (const label of DEFAULT_LABELS) {
    const existing = findLabelByName(label.name);
    if (existing) {
      run(
        `UPDATE labels
         SET color = ?,
             icon = ?,
             kind = ?,
             image_url = ?,
             target_laps = COALESCE(target_laps, ?),
             sort_order = COALESCE(sort_order, ?)
         WHERE id = ?`,
        [
          label.color ?? '#3b82f6',
          label.icon ?? label.name.slice(0, 2).toUpperCase(),
          label.kind ?? 'custom',
          label.imageUrl ?? null,
          label.targetLaps ?? null,
          label.sortOrder ?? null,
          existing.id,
        ]
      );
      continue;
    }
    createLabelRecord(label, label.id, DEFAULT_LABEL_CREATED_AT);
  }
}

export async function initDb(): Promise<void> {
  ensureDataDir();
  statementCache.clear();
  if (database) database.close();
  database = new Database(DB_FILE);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma(process.env.NODE_ENV === 'test' ? 'synchronous = NORMAL' : 'synchronous = FULL');
  database.pragma('busy_timeout = 5000');
  database.pragma('cache_size = -8192');
  database.pragma('temp_store = MEMORY');
  database.pragma('journal_size_limit = 16777216');
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

export function closeDb(): void {
  statementCache.clear();
  if (!database) return;
  database.close();
  database = null;
}

export async function backupDatabase(destination: string): Promise<void> {
  await getDb().backup(destination);
}

export function getSetting(key: string): string | null {
  const row = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  const result = run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, String(value)]);
  if (key === 'public_record_mode' && result.changes > 0) appDataRevision += 1;
}

function cleanPublicRecordMode(value: unknown): PublicRecordMode {
  return VALID_PUBLIC_RECORD_MODES.has(value as PublicRecordMode)
    ? (value as PublicRecordMode)
    : DEFAULT_PUBLIC_RECORD_MODE;
}

export function getAppSettings(): AppSettings {
  return {
    publicRecordMode: cleanPublicRecordMode(getSetting('public_record_mode')),
  };
}

export function setPublicRecordMode(mode: PublicRecordMode): AppSettings {
  setSetting('public_record_mode', cleanPublicRecordMode(mode));
  return getAppSettings();
}

export function ensureHostId(): string {
  const existing = getSetting('host_id');
  if (existing) return existing;
  const hostId = uuidv4();
  setSetting('host_id', hostId);
  return hostId;
}

function setReplicationSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)')
    .run(key, value);
}

export function ensureReplicationIdentity(): ReplicationIdentity {
  const hostId = ensureHostId();
  let clusterId = getSetting('replication_cluster_id');
  let clusterSecret = getSetting('replication_cluster_secret');
  if (!clusterId) {
    const generatedClusterId = process.env.CLUSTER_ID?.trim() || uuidv4();
    setReplicationSetting('replication_cluster_id', generatedClusterId);
    clusterId = generatedClusterId;
  }
  if (!clusterSecret) {
    const generatedClusterSecret =
      process.env.CLUSTER_SECRET?.trim() || crypto.randomBytes(32).toString('hex');
    setReplicationSetting('replication_cluster_secret', generatedClusterSecret);
    clusterSecret = generatedClusterSecret;
  }
  return { clusterId: clusterId!, clusterSecret: clusterSecret!, hostId };
}

export function assertOrClaimTimingController(): string {
  if (getOpenReplicationConflictCount() > 0) {
    throw new Error(
      'Timing is gepauzeerd door een syncconflict. Los dit eerst op in Admin.'
    );
  }
  const hostId = ensureReplicationIdentity().hostId;
  const current = getSetting('timing_controller_host_id');
  if (current && current !== hostId) {
    throw new Error('De timing wordt bediend op een andere laptop');
  }
  assignTimingController(hostId);
  return hostId;
}

export function claimTimingController(): string {
  const hostId = ensureReplicationIdentity().hostId;
  assignTimingController(hostId);
  return hostId;
}

export function assignTimingController(hostId: string): {
  hostId: string;
  generation: number;
} {
  const targetHostId = String(hostId || '').trim();
  if (!targetHostId || targetHostId.length > 128) {
    throw new Error('ongeldige timinglaptop');
  }
  const current = getSetting('timing_controller_host_id');
  const storedGeneration = Number(getSetting('timing_controller_generation') || 0);
  if (current === targetHostId && storedGeneration > 0) {
    return { hostId: targetHostId, generation: storedGeneration };
  }
  const generation = Math.max(0, Math.floor(storedGeneration) || 0) + 1;
  setSetting('timing_controller_host_id', targetHostId);
  setSetting('timing_controller_generation', String(generation));
  return { hostId: targetHostId, generation };
}

export function getTimingControllerGeneration(): number {
  const generation = Number(getSetting('timing_controller_generation') || 0);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

function nextLocalHlc(): { wallMs: number; counter: number } {
  const storedWall = Number(getSetting('replication_hlc_wall_ms') || 0);
  const storedCounter = Number(getSetting('replication_hlc_counter') || 0);
  const now = Date.now();
  const wallMs = Math.max(now, storedWall);
  const counter = wallMs === storedWall ? storedCounter + 1 : 0;
  setReplicationSetting('replication_hlc_wall_ms', String(wallMs));
  setReplicationSetting('replication_hlc_counter', String(counter));
  return { wallMs, counter };
}

function observeRemoteHlc(wallMs: number, counter: number): void {
  const storedWall = Number(getSetting('replication_hlc_wall_ms') || 0);
  const storedCounter = Number(getSetting('replication_hlc_counter') || 0);
  const now = Date.now();
  const nextWall = Math.max(now, storedWall, wallMs);
  const nextCounter =
    nextWall === storedWall && nextWall === wallMs
      ? Math.max(storedCounter, counter) + 1
      : nextWall === storedWall
        ? storedCounter + 1
        : nextWall === wallMs
          ? counter + 1
          : 0;
  setReplicationSetting('replication_hlc_wall_ms', String(nextWall));
  setReplicationSetting('replication_hlc_counter', String(nextCounter));
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

function ensureReplicationCheckpoint(): ReplicationCheckpoint {
  const stored = getSetting('replication_checkpoint_json');
  if (stored) return JSON.parse(stored) as ReplicationCheckpoint;
  const checkpoint = captureReplicationCheckpoint();
  setReplicationSetting('replication_checkpoint_json', JSON.stringify(checkpoint));
  return checkpoint;
}

export function getReplicationCheckpoint(): ReplicationCheckpoint {
  return ensureReplicationCheckpoint();
}

function restoreReplicationCheckpoint(checkpoint: ReplicationCheckpoint): void {
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

function replicationChecksum(input: Omit<ReplicationOperation, 'checksum' | 'status' | 'appliedAt'>): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        id: input.id,
        clusterId: input.clusterId,
        originHostId: input.originHostId,
        originSeq: input.originSeq,
        hlcWallMs: input.hlcWallMs,
        hlcCounter: input.hlcCounter,
        type: input.type,
        payload: input.payload,
        statements: input.statements,
        result: input.result,
        raceBaseKey: input.raceBaseKey,
        createdAt: input.createdAt,
      })
    )
    .digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue) => {
    if (
      nestedValue &&
      typeof nestedValue === 'object' &&
      !Array.isArray(nestedValue)
    ) {
      return Object.fromEntries(
        Object.entries(nestedValue as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b)
        )
      );
    }
    return nestedValue;
  });
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function replicationOperationFromRow(row: {
  id: string;
  clusterId: string;
  originHostId: string;
  originSeq: number;
  hlcWallMs: number;
  hlcCounter: number;
  type: string;
  payloadJson: string;
  statementsJson: string;
  resultJson: string;
  raceBaseKey: string | null;
  status: ReplicationOperation['status'];
  checksum: string;
  createdAt: number;
  appliedAt: number;
}): ReplicationOperation {
  return {
    id: row.id,
    clusterId: row.clusterId,
    originHostId: row.originHostId,
    originSeq: row.originSeq,
    hlcWallMs: row.hlcWallMs,
    hlcCounter: row.hlcCounter,
    type: row.type,
    payload: JSON.parse(row.payloadJson) as unknown,
    statements: JSON.parse(row.statementsJson) as ReplicatedSqlStatement[],
    result: JSON.parse(row.resultJson) as unknown,
    raceBaseKey: row.raceBaseKey,
    status: row.status,
    checksum: row.checksum,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  };
}

const REPLICATION_OPERATION_SELECT = `SELECT
  id,
  cluster_id AS clusterId,
  origin_host_id AS originHostId,
  origin_seq AS originSeq,
  hlc_wall_ms AS hlcWallMs,
  hlc_counter AS hlcCounter,
  type,
  payload_json AS payloadJson,
  statements_json AS statementsJson,
  result_json AS resultJson,
  race_base_key AS raceBaseKey,
  status,
  checksum,
  created_at AS createdAt,
  applied_at AS appliedAt
FROM replication_operations`;

export function commitReplicatedWrite<T>(input: {
  id?: string;
  type: string;
  payload?: unknown;
  raceBaseKey?: string | null;
  action: () => T;
}): T {
  const identity = ensureReplicationIdentity();
  const id = input.id || uuidv4();
  const existing = one<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT} WHERE id = ?`,
    [id]
  );
  if (existing) {
    const operation = replicationOperationFromRow(existing);
    if (
      operation.type !== input.type ||
      stableJson(operation.payload) !== stableJson(input.payload ?? null)
    ) {
      throw new Error('command id was already used for a different write');
    }
    return operation.result as T;
  }
  if (writeCapture) throw new Error('nested replicated write is not supported');

  return transaction(() => {
    ensureReplicationCheckpoint();
    const originSeq =
      (one<{ seq: number }>(
        `SELECT COALESCE(MAX(origin_seq), 0) AS seq
         FROM replication_operations
         WHERE origin_host_id = ?`,
        [identity.hostId]
      )?.seq ?? 0) + 1;
    const hlc = nextLocalHlc();
    const statements: ReplicatedSqlStatement[] = [];
    writeCapture = statements;
    let result: T;
    try {
      result = input.action();
    } finally {
      writeCapture = null;
    }
    const createdAt = Date.now();
    const base = {
      id,
      clusterId: identity.clusterId,
      originHostId: identity.hostId,
      originSeq,
      hlcWallMs: hlc.wallMs,
      hlcCounter: hlc.counter,
      type: input.type,
      payload: input.payload ?? null,
      statements,
      result: result ?? null,
      raceBaseKey: input.raceBaseKey ?? null,
      createdAt,
    };
    const checksum = replicationChecksum(base);
    getDb()
      .prepare(
        `INSERT INTO replication_operations (
          id, cluster_id, origin_host_id, origin_seq, hlc_wall_ms, hlc_counter,
          type, payload_json, statements_json, result_json, race_base_key,
          status, checksum, created_at, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`
      )
      .run(
        id,
        identity.clusterId,
        identity.hostId,
        originSeq,
        hlc.wallMs,
        hlc.counter,
        input.type,
        JSON.stringify(base.payload),
        JSON.stringify(statements),
        JSON.stringify(base.result),
        base.raceBaseKey,
        checksum,
        createdAt,
        createdAt
      );
    return result;
  });
}

export function getReplicationVector(): Record<string, number> {
  return Object.fromEntries(
    all<{ hostId: string; seq: number }>(
      `SELECT origin_host_id AS hostId, MAX(origin_seq) AS seq
       FROM replication_operations
       GROUP BY origin_host_id`
    ).map((row) => [row.hostId, row.seq])
  );
}

export function getReplicationOperationsMissing(
  vector: Record<string, number>,
  limit = 250
): ReplicationOperation[] {
  const origins = all<{ hostId: string }>(
    `SELECT DISTINCT origin_host_id AS hostId
     FROM replication_operations`
  );
  if (!origins.length) return [];

  const params: SqlValue[] = [];
  const conditions = origins.map(({ hostId }) => {
    const acknowledged = Number(
      hasOwn(vector, hostId) ? vector[hostId] : 0
    );
    params.push(
      hostId,
      Number.isFinite(acknowledged) ? Math.max(0, Math.floor(acknowledged)) : 0
    );
    return '(origin_host_id = ? AND origin_seq > ?)';
  });
  params.push(Math.max(1, Math.min(1_000, Math.floor(limit) || 250)));

  return all<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT}
     WHERE ${conditions.join(' OR ')}
     ORDER BY hlc_wall_ms, hlc_counter, origin_host_id, origin_seq
     LIMIT ?`,
    params
  )
    .map(replicationOperationFromRow);
}

export function getAllReplicationOperations(): ReplicationOperation[] {
  return all<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT}
     ORDER BY hlc_wall_ms, hlc_counter, origin_host_id, origin_seq`
  ).map(replicationOperationFromRow);
}

export function getReplicationOperation(id: string): ReplicationOperation | null {
  const row = one<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT} WHERE id = ?`,
    [id]
  );
  return row ? replicationOperationFromRow(row) : null;
}

export function getOpenReplicationConflictCount(): number {
  return (
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM replication_conflicts WHERE status = 'open'`
    )?.count ?? 0
  );
}

export function getReplicationConflicts(
  status: ReplicationConflict['status'] | 'all' = 'open'
): ReplicationConflict[] {
  const where = status === 'all' ? '' : 'WHERE status = ?';
  const params: SqlValue[] = status === 'all' ? [] : [status];
  return all<{
    id: string;
    kind: ReplicationConflict['kind'];
    operationIdsJson: string;
    status: ReplicationConflict['status'];
    resolutionOperationId: string | null;
    createdAt: number;
    resolvedAt: number | null;
  }>(
    `SELECT
       id,
       kind,
       operation_ids_json AS operationIdsJson,
       status,
       resolution_operation_id AS resolutionOperationId,
       created_at AS createdAt,
       resolved_at AS resolvedAt
     FROM replication_conflicts
     ${where}
     ORDER BY created_at DESC`,
    params
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    operationIds: JSON.parse(row.operationIdsJson) as string[],
    status: row.status,
    resolutionOperationId: row.resolutionOperationId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  })).map((conflict) => ({
    ...conflict,
    operations: conflict.operationIds.flatMap((id) => {
      const operation = getReplicationOperation(id);
      return operation
        ? [{
            id: operation.id,
            originHostId: operation.originHostId,
            type: operation.type,
            createdAt: operation.createdAt,
          }]
        : [];
    }),
  }));
}

export function prepareReplicationConflictChoice(
  conflictId: string,
  selectedOperationId: string
): void {
  const conflict = getReplicationConflicts().find((item) => item.id === conflictId);
  if (!conflict) throw new Error('syncconflict niet gevonden of al opgelost');
  if (!conflict.operationIds.includes(selectedOperationId)) {
    throw new Error('de gekozen timingversie hoort niet bij dit conflict');
  }
  rebuildApplicationFromReplicationLog(new Set([selectedOperationId]));
}

export function finalizeReplicationConflict(
  conflictId: string,
  snapshot: AppSnapshot
): { conflictId: string; kept: 'current' } {
  const conflict = one<{ id: string }>(
    `SELECT id FROM replication_conflicts
     WHERE id = ? AND status = 'open'`,
    [conflictId]
  );
  if (!conflict) throw new Error('syncconflict niet gevonden of al opgelost');
  applySnapshot(snapshot);
  getDb()
    .prepare(
      `UPDATE replication_conflicts
       SET status = 'resolved', resolved_at = ?
       WHERE id = ?`
    )
    .run(Date.now(), conflictId);
  return { conflictId, kept: 'current' };
}

export function getPendingReplicationOperationCount(): number {
  const peers =
    one<{ count: number }>(
      'SELECT COUNT(DISTINCT peer_host_id) AS count FROM replication_peer_progress'
    )?.count ?? 0;
  if (!peers) return 0;
  const local = ensureReplicationIdentity().hostId;
  const acknowledged =
    one<{ seq: number }>(
      `SELECT COALESCE(MIN(COALESCE(progress.acknowledged_seq, 0)), 0) AS seq
       FROM (
         SELECT DISTINCT peer_host_id
         FROM replication_peer_progress
       ) AS peers
       LEFT JOIN replication_peer_progress AS progress
         ON progress.peer_host_id = peers.peer_host_id
        AND progress.origin_host_id = ?`,
      [local]
    )?.seq ?? 0;
  return (
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM replication_operations
       WHERE origin_host_id = ? AND origin_seq > ?`,
      [local, acknowledged]
    )?.count ?? 0
  );
}

export function acknowledgeReplicationVector(
  peerHostId: string,
  vector: Record<string, number>
): void {
  const now = Date.now();
  const origins = new Set([peerHostId, ...Object.keys(vector)]);
  transaction(() => {
    for (const originHostId of origins) {
      const seq = Number(
        hasOwn(vector, originHostId) ? vector[originHostId] : 0
      );
      getDb()
        .prepare(
          `INSERT INTO replication_peer_progress (
             peer_host_id, origin_host_id, acknowledged_seq, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(peer_host_id, origin_host_id) DO UPDATE SET
             acknowledged_seq = MAX(replication_peer_progress.acknowledged_seq, excluded.acknowledged_seq),
             updated_at = excluded.updated_at`
        )
        .run(
          peerHostId,
          originHostId,
          Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : 0,
          now
        );
    }
  });
}

function insertReplicationOperation(operation: ReplicationOperation): void {
  getDb()
    .prepare(
      `INSERT INTO replication_operations (
        id, cluster_id, origin_host_id, origin_seq, hlc_wall_ms, hlc_counter,
        type, payload_json, statements_json, result_json, race_base_key,
        status, checksum, created_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      operation.id,
      operation.clusterId,
      operation.originHostId,
      operation.originSeq,
      operation.hlcWallMs,
      operation.hlcCounter,
      operation.type,
      JSON.stringify(operation.payload),
      JSON.stringify(operation.statements),
      JSON.stringify(operation.result),
      operation.raceBaseKey,
      operation.status,
      operation.checksum,
      operation.createdAt,
      operation.appliedAt
    );
}

function operationConflictId(operationIds: string[]): string {
  return crypto
    .createHash('sha256')
    .update(operationIds.slice().sort().join(':'))
    .digest('hex');
}

function saveReplicationConflict(
  kind: ReplicationConflict['kind'],
  operationIds: string[]
): string {
  const sortedIds = operationIds.slice().sort();
  const id = operationConflictId(sortedIds);
  getDb()
    .prepare(
      `INSERT INTO replication_conflicts (
         id, kind, operation_ids_json, status, created_at
       ) VALUES (?, ?, ?, 'open', ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         operation_ids_json = excluded.operation_ids_json`
    )
    .run(id, kind, JSON.stringify(sortedIds), Date.now());
  return id;
}

function resolutionConflictId(operation: ReplicationOperation): string | null {
  if (operation.type !== 'cluster.resolveConflict') return null;
  if (!operation.payload || typeof operation.payload !== 'object') return null;
  const payload = operation.payload as {
    conflictId?: unknown;
    input?: { conflictId?: unknown };
  };
  const id = payload.conflictId ?? payload.input?.conflictId;
  return typeof id === 'string' && id ? id : null;
}

function compareReplicationOperations(
  a: ReplicationOperation,
  b: ReplicationOperation
): number {
  return (
    a.hlcWallMs - b.hlcWallMs ||
    a.hlcCounter - b.hlcCounter ||
    a.originHostId.localeCompare(b.originHostId) ||
    a.originSeq - b.originSeq
  );
}

function rebuildApplicationFromReplicationLog(
  preferredOperationIds: ReadonlySet<string> = new Set()
): void {
  const checkpoint = ensureReplicationCheckpoint();
  const operations = all<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT}
     ORDER BY hlc_wall_ms, hlc_counter, origin_host_id, origin_seq`
  )
    .map(replicationOperationFromRow)
    .filter(
      (operation) =>
        operation.originSeq > (checkpoint.vector[operation.originHostId] || 0)
    );
  const raceGroups = new Map<string, ReplicationOperation[]>();
  for (const operation of operations) {
    if (!operation.raceBaseKey) continue;
    const group = raceGroups.get(operation.raceBaseKey) || [];
    group.push(operation);
    raceGroups.set(operation.raceBaseKey, group);
  }
  const raceChoices = new Map<string, string>();
  for (const [raceBaseKey, group] of raceGroups) {
    const preferred = group.find((operation) => preferredOperationIds.has(operation.id));
    raceChoices.set(raceBaseKey, (preferred || group[0]).id);
  }

  transaction(() => {
    restoreReplicationCheckpoint(checkpoint);
    getDb()
      .prepare(
        `DELETE FROM replication_conflicts
         WHERE resolution_operation_id IS NULL`
      )
      .run();

    for (const operation of operations) {
      let conflictKind: ReplicationConflict['kind'] | null = null;
      let conflictOperationIds = [operation.id];
      const raceChoice = operation.raceBaseKey
        ? raceChoices.get(operation.raceBaseKey)
        : null;
      if (raceChoice && raceChoice !== operation.id) {
        conflictKind = 'timing';
        conflictOperationIds = [raceChoice, operation.id];
      } else {
        try {
          getDb().transaction(() => {
            for (const item of operation.statements) {
              getDb().prepare(item.sql).run(...item.params);
            }
          })();
        } catch {
          conflictKind = operation.raceBaseKey ? 'timing' : 'data';
        }
      }

      const status: ReplicationOperation['status'] = conflictKind
        ? 'conflict'
        : 'accepted';
      getDb()
        .prepare(
          `UPDATE replication_operations
           SET status = ?, applied_at = ?
           WHERE id = ?`
        )
        .run(status, Date.now(), operation.id);

      if (conflictKind) {
        saveReplicationConflict(conflictKind, conflictOperationIds);
        continue;
      }
      const resolvedConflictId = resolutionConflictId(operation);
      if (resolvedConflictId) {
        const resolution = getDb()
          .prepare(
            `UPDATE replication_conflicts
             SET status = 'resolved',
                 resolution_operation_id = ?,
                 resolved_at = ?
             WHERE id = ?`
          )
          .run(operation.id, Date.now(), resolvedConflictId);
        if (resolution.changes === 0) {
          console.warn(
            `Conflict resolution ${operation.id} did not find conflict ${resolvedConflictId}`
          );
        }
      }
    }
  });
  appDataRevision += 1;
}

function assertValidReplicationOperation(operation: ReplicationOperation): void {
  const validText = (value: unknown, maxLength: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  if (
    !operation ||
    typeof operation !== 'object' ||
    !validText(operation.id, 128) ||
    !validText(operation.clusterId, 128) ||
    !validText(operation.originHostId, 128) ||
    !Number.isSafeInteger(operation.originSeq) ||
    operation.originSeq < 1 ||
    !Number.isSafeInteger(operation.hlcWallMs) ||
    operation.hlcWallMs < 0 ||
    !Number.isSafeInteger(operation.hlcCounter) ||
    operation.hlcCounter < 0 ||
    !validText(operation.type, 128) ||
    !Array.isArray(operation.statements) ||
    operation.statements.length > 100_000 ||
    (operation.raceBaseKey !== null &&
      !validText(operation.raceBaseKey, 1_024)) ||
    !/^[0-9a-f]{64}$/i.test(operation.checksum) ||
    !Number.isSafeInteger(operation.createdAt) ||
    operation.createdAt < 0
  ) {
    throw new Error('invalid replication operation');
  }

  for (const item of operation.statements) {
    if (
      !item ||
      typeof item.sql !== 'string' ||
      item.sql.length === 0 ||
      item.sql.length > 100_000 ||
      !isReplicatedMutation(item.sql) ||
      !Array.isArray(item.params) ||
      item.params.length > 10_000 ||
      item.params.some(
        (value) =>
          value !== null &&
          typeof value !== 'string' &&
          (typeof value !== 'number' || !Number.isFinite(value))
      )
    ) {
      throw new Error(`invalid replicated statement for ${operation.id}`);
    }
  }
}

export function applyRemoteReplicationOperations(
  operations: ReplicationOperation[]
): { applied: number; duplicates: number; conflicts: number } {
  const identity = ensureReplicationIdentity();
  if (!Array.isArray(operations) || operations.length > 1_000) {
    throw new Error('invalid replication batch');
  }
  let duplicates = 0;
  const insertedIds: string[] = [];
  const insertedOperations: ReplicationOperation[] = [];
  const previousLastRow = one<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT}
     ORDER BY hlc_wall_ms DESC, hlc_counter DESC, origin_host_id DESC, origin_seq DESC
     LIMIT 1`
  );
  const previousLastOperation = previousLastRow
    ? replicationOperationFromRow(previousLastRow)
    : null;
  const seenRaceBases = new Set(
    all<{ raceBaseKey: string }>(
      `SELECT DISTINCT race_base_key AS raceBaseKey
       FROM replication_operations
       WHERE status = 'accepted' AND race_base_key IS NOT NULL`
    ).map((row) => row.raceBaseKey)
  );
  let requiresRebuild = false;
  const ordered = operations.slice().sort(compareReplicationOperations);
  const expectedVector = getReplicationVector();

  for (const operation of ordered) {
    assertValidReplicationOperation(operation);
    if (operation.clusterId !== identity.clusterId) {
      throw new Error('replication cluster mismatch');
    }
    const existing = getReplicationOperation(operation.id);
    if (existing) {
      if (existing.checksum !== operation.checksum) {
        throw new Error(`replication operation id collision for ${operation.id}`);
      }
      duplicates += 1;
      continue;
    }
    const expectedChecksum = replicationChecksum({
      id: operation.id,
      clusterId: operation.clusterId,
      originHostId: operation.originHostId,
      originSeq: operation.originSeq,
      hlcWallMs: operation.hlcWallMs,
      hlcCounter: operation.hlcCounter,
      type: operation.type,
      payload: operation.payload,
      statements: operation.statements,
      result: operation.result,
      raceBaseKey: operation.raceBaseKey,
      createdAt: operation.createdAt,
    });
    if (operation.checksum !== expectedChecksum) {
      throw new Error(`replication checksum mismatch for ${operation.id}`);
    }
    const hasKnownOrigin = hasOwn(
      expectedVector,
      operation.originHostId
    );
    const knownSeq = hasKnownOrigin
      ? expectedVector[operation.originHostId]
      : 0;
    if (
      knownSeq === 0 &&
      !hasKnownOrigin &&
      Object.keys(expectedVector).length >= MAX_REPLICATION_ORIGINS
    ) {
      throw new Error('replication origin limit exceeded');
    }
    if (operation.originSeq !== knownSeq + 1) {
      throw new Error(
        `replication gap for ${operation.originHostId}: expected ${knownSeq + 1}, received ${operation.originSeq}`
      );
    }
    expectedVector[operation.originHostId] = operation.originSeq;
    insertedIds.push(operation.id);
    insertedOperations.push(operation);
    if (
      previousLastOperation &&
      compareReplicationOperations(operation, previousLastOperation) < 0
    ) {
      requiresRebuild = true;
    }
    if (operation.raceBaseKey) {
      if (seenRaceBases.has(operation.raceBaseKey)) requiresRebuild = true;
      seenRaceBases.add(operation.raceBaseKey);
    }
  }
  if (insertedIds.length) {
    ensureReplicationCheckpoint();
    const insertOperations = () => {
      for (const operation of insertedOperations) {
        insertReplicationOperation({
          ...operation,
          status: 'accepted',
          appliedAt: Date.now(),
        });
        observeRemoteHlc(operation.hlcWallMs, operation.hlcCounter);
      }
    };

    if (requiresRebuild) {
      transaction(() => {
        insertOperations();
        rebuildApplicationFromReplicationLog();
      });
    } else {
      try {
        transaction(() => {
          insertOperations();
          for (const operation of insertedOperations) {
            for (const item of operation.statements) {
              getDb().prepare(item.sql).run(...item.params);
            }
            const resolvedConflictId = resolutionConflictId(operation);
            if (resolvedConflictId) {
              getDb()
                .prepare(
                  `UPDATE replication_conflicts
                   SET status = 'resolved',
                       resolution_operation_id = ?,
                       resolved_at = ?
                   WHERE id = ?`
                )
                .run(operation.id, Date.now(), resolvedConflictId);
            }
          }
        });
        appDataRevision += 1;
      } catch {
        transaction(() => {
          insertOperations();
          rebuildApplicationFromReplicationLog();
        });
      }
    }
  }
  const conflicts = insertedIds.filter(
    (id) => getReplicationOperation(id)?.status === 'conflict'
  ).length;
  const applied = insertedIds.length - conflicts;
  return { applied, duplicates, conflicts };
}

export async function installReplicationBootstrap(input: {
  clusterId: string;
  clusterSecret: string;
  snapshot: AppSnapshot;
  checkpoint: ReplicationCheckpoint;
  operations: ReplicationOperation[];
  conflicts: ReplicationConflict[];
  timingControllerHostId: string | null;
}): Promise<{ backupPath: string }> {
  for (const operation of input.operations) {
    if (operation.clusterId !== input.clusterId) {
      throw new Error('bootstrap bevat wijzigingen uit een andere cluster');
    }
    const expectedChecksum = replicationChecksum({
      id: operation.id,
      clusterId: operation.clusterId,
      originHostId: operation.originHostId,
      originSeq: operation.originSeq,
      hlcWallMs: operation.hlcWallMs,
      hlcCounter: operation.hlcCounter,
      type: operation.type,
      payload: operation.payload,
      statements: operation.statements,
      result: operation.result,
      raceBaseKey: operation.raceBaseKey,
      createdAt: operation.createdAt,
    });
    if (operation.checksum !== expectedChecksum) {
      throw new Error(`bootstrap checksum klopt niet voor ${operation.id}`);
    }
  }

  const backupPath = path.join(
    DATA_DIR,
    `app.before-cluster-join-${Date.now()}-${uuidv4().slice(0, 8)}.sqlite`
  );
  await getDb().backup(backupPath);
  transaction(() => {
    getDb().prepare('DELETE FROM replication_peer_progress').run();
    getDb().prepare('DELETE FROM replication_conflicts').run();
    getDb().prepare('DELETE FROM replication_operations').run();
    applySnapshot(input.snapshot);
    setReplicationSetting('replication_cluster_id', input.clusterId);
    setReplicationSetting('replication_cluster_secret', input.clusterSecret);
    setReplicationSetting(
      'replication_checkpoint_json',
      JSON.stringify(input.checkpoint)
    );
    if (input.timingControllerHostId) {
      setReplicationSetting(
        'timing_controller_host_id',
        input.timingControllerHostId
      );
    } else {
      getDb()
        .prepare("DELETE FROM settings WHERE key = 'timing_controller_host_id'")
        .run();
    }
    for (const operation of input.operations) {
      insertReplicationOperation(operation);
    }
    for (const conflict of input.conflicts) {
      getDb()
        .prepare(
          `INSERT INTO replication_conflicts (
             id, kind, operation_ids_json, status, resolution_operation_id,
             created_at, resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          conflict.id,
          conflict.kind,
          JSON.stringify(conflict.operationIds),
          conflict.status,
          conflict.resolutionOperationId,
          conflict.createdAt,
          conflict.resolvedAt
        );
    }
  });
  if (input.operations.length) rebuildApplicationFromReplicationLog();
  appDataRevision += 1;
  return { backupPath };
}

export function getLabels(): Label[] {
  return all<Label>(
    `SELECT
       id,
       name,
       color,
       icon,
       kind,
       image_url AS imageUrl,
       target_laps AS targetLaps,
       sort_order AS sortOrder,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM labels
     ORDER BY
       COALESCE(sort_order, 9999),
       name`
  );
}

export function findLabelByName(name: unknown): Label | null {
  const normalized = normalizeName(canonicalLabelName(name));
  if (!normalized) return null;
  return one<Label>(
    `SELECT
       id,
       name,
       color,
       icon,
       kind,
       image_url AS imageUrl,
       target_laps AS targetLaps,
       sort_order AS sortOrder,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM labels
     WHERE name = ? COLLATE NOCASE
     LIMIT 1`,
    [canonicalLabelName(name)]
  );
}

export function ensureLabel(name: unknown, options: Partial<LabelInput> = {}): Label | null {
  const labelName = canonicalLabelName(name);
  if (!labelName) return null;
  const existing = findLabelByName(labelName);
  if (existing) return existing;
  return createLabel({
    name: labelName,
    color: options.color || '#3b82f6',
    icon: options.icon || labelName.slice(0, 2).toUpperCase(),
    kind: options.kind || 'custom',
    imageUrl: options.imageUrl || null,
    targetLaps: options.targetLaps ?? null,
    sortOrder: options.sortOrder ?? null,
  });
}

function createLabelRecord(input: LabelInput, id: string, now: number): Label {
  const labelName = cleanText(input.name);
  if (!labelName) throw new Error('label name required');
  if (findLabelByName(labelName)) {
    throw new Error('Er bestaat al een label met deze naam');
  }
  const label = {
    id,
    name: labelName,
    color: cleanText(input.color) || '#3b82f6',
    icon: cleanText(input.icon) || labelName.slice(0, 2).toUpperCase(),
    kind: cleanText(input.kind) || 'custom',
    imageUrl: cleanText(input.imageUrl),
    targetLaps: cleanInt(input.targetLaps),
    sortOrder: cleanInt(input.sortOrder),
  };
  run(
    `INSERT INTO labels (
      id,
      name,
      color,
      icon,
      kind,
      image_url,
      target_laps,
      sort_order,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      label.id,
      label.name,
      label.color,
      label.icon,
      label.kind,
      label.imageUrl,
      label.targetLaps,
      label.sortOrder,
      now,
      now,
    ]
  );
  if (label.kind === TEMPORARY_TEAM_KIND) {
    run('INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at) VALUES (?, 0, NULL)', [
      label.id,
    ]);
  }
  return { ...label, createdAt: now, updatedAt: now };
}

export function createLabel(input: LabelInput): Label {
  return createLabelRecord(input, uuidv4(), Date.now());
}

export function updateLabel(id: string, fields: LabelPatch): Label | null {
  const existing = one<{
    name: string;
    color: string;
    icon: string;
    kind: string;
    imageUrl: string | null;
    targetLaps: number | null;
    sortOrder: number | null;
  }>(
    `SELECT
       name,
       color,
       icon,
       kind,
       image_url AS imageUrl,
       target_laps AS targetLaps,
       sort_order AS sortOrder
     FROM labels
     WHERE id = ?`,
    [id]
  );
  if (!existing) return null;
  const temporaryState = one<{ active: number }>('SELECT active FROM temporary_teams WHERE label_id = ?', [id]);
  if (temporaryState?.active && fields.kind !== undefined && fields.kind !== TEMPORARY_TEAM_KIND) {
    throw new Error('Een actieve tijdelijke nachtploeg kan niet van type veranderen');
  }

  const next = {
    name: fields.name !== undefined ? cleanText(fields.name) || existing.name : existing.name,
    color: fields.color !== undefined ? cleanText(fields.color) || existing.color : existing.color,
    icon: fields.icon !== undefined ? cleanText(fields.icon) || existing.icon : existing.icon,
    kind: fields.kind !== undefined ? cleanText(fields.kind) || existing.kind : existing.kind,
    imageUrl: fields.imageUrl !== undefined ? cleanText(fields.imageUrl) || null : existing.imageUrl,
    targetLaps: fields.targetLaps !== undefined ? cleanInt(fields.targetLaps) : existing.targetLaps,
    sortOrder: fields.sortOrder !== undefined ? cleanInt(fields.sortOrder) : existing.sortOrder,
    updatedAt: Date.now(),
  };
  const conflictingLabel = findLabelByName(next.name);
  if (conflictingLabel && conflictingLabel.id !== id) {
    throw new Error('Er bestaat al een label met deze naam');
  }
  if (
    fields.kind !== undefined &&
    next.kind !== existing.kind &&
    isRestoreLabelForActiveTemporaryTeam(id)
  ) {
    throw new Error('Deactiveer de tijdelijke nachtploeg voordat je dit speedteamtype wijzigt');
  }

  run(
    `UPDATE labels
     SET name = ?,
         color = ?,
         icon = ?,
         kind = ?,
         image_url = ?,
         target_laps = ?,
         sort_order = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      next.name,
      next.color,
      next.icon,
      next.kind,
      next.imageUrl,
      next.targetLaps,
      next.sortOrder,
      next.updatedAt,
      id,
    ]
  );

  if (next.kind === TEMPORARY_TEAM_KIND) {
    run('INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at) VALUES (?, 0, NULL)', [id]);
  } else {
    run('DELETE FROM temporary_teams WHERE label_id = ? AND active = 0', [id]);
  }

  return getLabels().find((label) => label.id === id) ?? null;
}

export function deleteLabel(id: string): boolean {
  const temporaryState = one<{ active: number }>('SELECT active FROM temporary_teams WHERE label_id = ?', [id]);
  if (temporaryState?.active) throw new Error('Deactiveer deze tijdelijke nachtploeg voor je ze verwijdert');
  if (isRestoreLabelForActiveTemporaryTeam(id)) {
    throw new Error('Deactiveer de tijdelijke nachtploeg voordat je dit speedteamlabel verwijdert');
  }
  return transaction(() => {
    run('DELETE FROM runner_labels WHERE label_id = ?', [id]);
    return run('DELETE FROM labels WHERE id = ?', [id]).changes > 0;
  });
}

function isRestoreLabelForActiveTemporaryTeam(labelId: string): boolean {
  return all<{ restoreJson: string | null }>(
    `SELECT ttm.restore_label_ids_json AS restoreJson
     FROM temporary_team_members ttm
     JOIN temporary_teams tt ON tt.label_id = ttm.team_label_id
     WHERE tt.active = 1
       AND ttm.restore_label_ids_json IS NOT NULL`
  ).some((row) => parseStringArray(row.restoreJson).includes(labelId));
}

function getRunnerLabelsMap(runnerId?: string): Map<string, Label[]> {
  const rows = all<Label & { runnerId: string }>(
    `SELECT
      rl.runner_id AS runnerId,
      l.id,
      l.name,
      l.color,
      l.icon,
      l.kind,
      l.image_url AS imageUrl,
      l.target_laps AS targetLaps,
      l.sort_order AS sortOrder,
      l.created_at AS createdAt,
      l.updated_at AS updatedAt
    FROM runner_labels rl
    JOIN labels l ON l.id = rl.label_id
    ${runnerId ? 'WHERE rl.runner_id = ?' : ''}
    ORDER BY COALESCE(l.sort_order, 9999), l.name`,
    runnerId ? [runnerId] : []
  );
  const map = new Map<string, Label[]>();
  for (const row of rows) {
    if (!map.has(row.runnerId)) map.set(row.runnerId, []);
    map.get(row.runnerId)?.push({
      id: row.id,
      name: row.name,
      color: row.color,
      icon: row.icon,
      kind: row.kind,
      imageUrl: row.imageUrl ?? null,
      targetLaps: row.targetLaps ?? null,
      sortOrder: row.sortOrder ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
  return map;
}

function getRunnerLabels(runnerId: string): Label[] {
  return getRunnerLabelsMap(runnerId).get(runnerId) ?? [];
}

function syncTemporaryTeamRows(): void {
  run(
    `INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at)
     SELECT id, 0, NULL FROM labels WHERE kind = ?`,
    [TEMPORARY_TEAM_KIND]
  );
}

export function getTemporaryTeams(): TemporaryTeam[] {
  const members = all<{ labelId: string; runnerId: string; restoreJson: string | null }>(
    `SELECT team_label_id AS labelId, runner_id AS runnerId, restore_label_ids_json AS restoreJson
     FROM temporary_team_members
     ORDER BY runner_id`
  );
  const membersByTeam = new Map<string, string[]>();
  const restoresByTeam = new Map<string, Record<string, string[]>>();
  for (const member of members) {
    const teamMembers = membersByTeam.get(member.labelId);
    if (teamMembers) teamMembers.push(member.runnerId);
    else membersByTeam.set(member.labelId, [member.runnerId]);
    const restores = restoresByTeam.get(member.labelId) ?? {};
    restores[member.runnerId] = parseStringArray(member.restoreJson);
    restoresByTeam.set(member.labelId, restores);
  }
  return all<{ labelId: string; active: number; activatedAt: number | null }>(
    `SELECT tt.label_id AS labelId, tt.active, tt.activated_at AS activatedAt
     FROM temporary_teams tt
     JOIN labels l ON l.id = tt.label_id
     WHERE l.kind = ?
     ORDER BY COALESCE(l.sort_order, 9999), l.name`,
    [TEMPORARY_TEAM_KIND]
  ).map((team) => ({
    labelId: team.labelId,
    active: Boolean(team.active),
    activatedAt: team.activatedAt ?? null,
    memberRunnerIds: membersByTeam.get(team.labelId) ?? [],
    restoreLabelIdsByRunner: restoresByTeam.get(team.labelId) ?? {},
  }));
}

export function setTemporaryTeamMembers(labelId: string, runnerIds: string[]): TemporaryTeam {
  const label = one<{ id: string; kind: string }>('SELECT id, kind FROM labels WHERE id = ?', [labelId]);
  if (!label || label.kind !== TEMPORARY_TEAM_KIND) throw new Error('Tijdelijke nachtploeg niet gevonden');
  const state = one<{ active: number }>('SELECT active FROM temporary_teams WHERE label_id = ?', [labelId]);
  if (state?.active) throw new Error('Deactiveer de ploeg voordat je de ledenlijst wijzigt');
  const uniqueRunnerIds = [...new Set(runnerIds)];
  for (const runnerId of uniqueRunnerIds) {
    if (!one<{ id: string }>('SELECT id FROM runners WHERE id = ?', [runnerId])) {
      throw new Error('Een geselecteerde loper bestaat niet meer');
    }
    const other = one<{ labelId: string }>(
      `SELECT team_label_id AS labelId FROM temporary_team_members
       WHERE runner_id = ? AND team_label_id <> ?`,
      [runnerId, labelId]
    );
    if (other) throw new Error('Een loper kan maar in een tijdelijke nachtploeg zitten');
  }

  transaction(() => {
    run('INSERT OR IGNORE INTO temporary_teams (label_id, active, activated_at) VALUES (?, 0, NULL)', [labelId]);
    run('DELETE FROM temporary_team_members WHERE team_label_id = ?', [labelId]);
    for (const runnerId of uniqueRunnerIds) {
      run(
        `INSERT INTO temporary_team_members (team_label_id, runner_id, restore_label_ids_json)
         VALUES (?, ?, NULL)`,
        [labelId, runnerId]
      );
    }
  });
  const team = getTemporaryTeams().find((item) => item.labelId === labelId);
  if (!team) throw new Error('Tijdelijke nachtploeg opslaan mislukt');
  return team;
}

export function setTemporaryTeamActive(labelId: string, active: boolean, nowMs = Date.now()): TemporaryTeam {
  const team = getTemporaryTeams().find((item) => item.labelId === labelId);
  if (!team) throw new Error('Tijdelijke nachtploeg niet gevonden');
  if (team.active === active) return team;
  if (active && team.memberRunnerIds.length === 0) throw new Error('Voeg eerst minstens een loper toe');

  transaction(() => {
    if (active) {
      for (const runnerId of team.memberRunnerIds) {
        const baseTeams = getRunnerLabels(runnerId).filter((label) => label.kind === 'speedteam');
        if (baseTeams.length !== 1) {
          const runner = getRunnerById(runnerId);
          throw new Error(`${runner?.name ?? 'Loper'} moet exact een gewone speedteamploeg hebben`);
        }
        run(
          `UPDATE temporary_team_members SET restore_label_ids_json = ?
           WHERE team_label_id = ? AND runner_id = ?`,
          [JSON.stringify(baseTeams.map((label) => label.id)), labelId, runnerId]
        );
        run(
          `DELETE FROM runner_labels
           WHERE runner_id = ? AND label_id IN (
             SELECT id FROM labels WHERE kind IN ('speedteam', 'temporary_team')
           )`,
          [runnerId]
        );
        run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [runnerId, labelId]);
      }
      run('UPDATE temporary_teams SET active = 1, activated_at = ? WHERE label_id = ?', [nowMs, labelId]);
    } else {
      const restores = all<{ runnerId: string; restoreJson: string | null }>(
        `SELECT runner_id AS runnerId, restore_label_ids_json AS restoreJson
         FROM temporary_team_members WHERE team_label_id = ?`,
        [labelId]
      );
      for (const restore of restores) {
        run('DELETE FROM runner_labels WHERE runner_id = ? AND label_id = ?', [restore.runnerId, labelId]);
        const ids = parseStringArray(restore.restoreJson);
        for (const restoreLabelId of ids) {
          run(
            `INSERT OR IGNORE INTO runner_labels (runner_id, label_id)
             SELECT ?, id FROM labels WHERE id = ?`,
            [restore.runnerId, restoreLabelId]
          );
        }
      }
      run('UPDATE temporary_team_members SET restore_label_ids_json = NULL WHERE team_label_id = ?', [labelId]);
      run('UPDATE temporary_teams SET active = 0, activated_at = NULL WHERE label_id = ?', [labelId]);
    }
  });
  const updated = getTemporaryTeams().find((item) => item.labelId === labelId);
  if (!updated) throw new Error('Tijdelijke nachtploeg aanpassen mislukt');
  return updated;
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

type RunnerRow = Omit<Runner, 'labels' | 'hiddenFromQueue'> & {
  queueHiddenAt: number | null;
};

const RUNNER_SELECT_SQL = `
  SELECT
    r.id,
    r.runner_number AS runnerNumber,
    r.name,
    r.target_laps AS targetLaps,
    r.historical_avg_ms AS historicalAvgMs,
    r.historical_best_ms AS historicalBestMs,
    r.registration_source AS registrationSource,
    r.notes,
    r.created_at AS createdAt,
    r.updated_at AS updatedAt,
    COALESCE(q.status, 'registered') AS status,
    q.status_since AS statusSince,
    q.queue_index AS queueIndex,
    q.hidden_at AS queueHiddenAt,
    COUNT(l.id) AS lapCount,
    MAX(l.duration_ms) AS slowestLapMs,
    MIN(l.duration_ms) AS bestLapMs,
    CASE WHEN COUNT(l.id) = 0 THEN NULL ELSE ROUND(AVG(l.duration_ms)) END AS averageLapMs,
    COALESCE(SUM(l.duration_ms), 0) AS totalTimeMs,
    (
      SELECT duration_ms
      FROM laps last_lap
      WHERE last_lap.runner_id = r.id
      ORDER BY last_lap.finished_at DESC
      LIMIT 1
    ) AS lastLapMs
  FROM runners r
  LEFT JOIN queue_entries q ON q.runner_id = r.id
  LEFT JOIN laps l ON l.runner_id = r.id
`;

function runnerFromRow(row: RunnerRow, labels: Label[]): Runner {
  return {
    id: row.id,
    runnerNumber: row.runnerNumber ?? null,
    name: row.name,
    targetLaps: row.targetLaps ?? null,
    historicalAvgMs: row.historicalAvgMs ?? null,
    historicalBestMs: row.historicalBestMs ?? null,
    registrationSource: cleanRegistrationSource(row.registrationSource),
    notes: row.notes ?? '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: cleanStatus(row.status),
    statusSince: row.statusSince ?? null,
    queueIndex: row.queueIndex ?? null,
    hiddenFromQueue: row.queueHiddenAt !== null && row.queueHiddenAt !== undefined,
    queueHiddenAt: row.queueHiddenAt ?? null,
    labels,
    lapCount: Number(row.lapCount || 0),
    lastLapMs: row.lastLapMs ?? null,
    bestLapMs: row.bestLapMs ?? null,
    slowestLapMs: row.slowestLapMs ?? null,
    averageLapMs: row.averageLapMs ?? null,
    totalTimeMs: Number(row.totalTimeMs || 0),
  };
}

export function getAllRunners(): Runner[] {
  const labelsByRunner = getRunnerLabelsMap();
  const rows = all<RunnerRow>(
    `${RUNNER_SELECT_SQL}
     GROUP BY r.id
     ORDER BY
       CASE COALESCE(q.status, 'registered')
         WHEN 'running' THEN 0
         WHEN 'waiting' THEN 1
         WHEN 'warming_up' THEN 2
         WHEN 'ran' THEN 3
         ELSE 4
       END,
       q.queue_index,
       r.name`
  );

  return rows.map((row) => runnerFromRow(row, labelsByRunner.get(row.id) ?? []));
}

export function getRunnerById(id: string): Runner | null {
  const row = one<RunnerRow>(
    `${RUNNER_SELECT_SQL}
     WHERE r.id = ?
     GROUP BY r.id`,
    [id]
  );
  return row ? runnerFromRow(row, getRunnerLabels(id)) : null;
}

export function getRunnersByIds(ids: string[]): Runner[] {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const labelsByRunner = getRunnerLabelsMap();
  const rows = all<RunnerRow>(
    `${RUNNER_SELECT_SQL}
     WHERE r.id IN (${placeholders})
     GROUP BY r.id`,
    uniqueIds
  );
  return rows.map((row) => runnerFromRow(row, labelsByRunner.get(row.id) ?? []));
}

function getActiveTemporaryTeamLabelIdForRunner(runnerId: string): string | null {
  const row = one<{ labelId: string }>(
    `SELECT ttm.team_label_id AS labelId
     FROM temporary_team_members ttm
     JOIN temporary_teams tt ON tt.label_id = ttm.team_label_id
     WHERE ttm.runner_id = ? AND tt.active = 1`,
    [runnerId]
  );
  return row?.labelId ?? null;
}

function findRunnerByNumber(runnerNumber: unknown): { id: string } | null {
  const number = cleanText(runnerNumber);
  if (!number) return null;
  return one<{ id: string }>('SELECT id FROM runners WHERE runner_number = ?', [number]);
}

export function setRunnerLabels(runnerId: string, labelNamesOrIds: unknown): void {
  run('DELETE FROM runner_labels WHERE runner_id = ?', [runnerId]);
  const labels = Array.isArray(labelNamesOrIds) ? labelNamesOrIds : [];
  const activeTemporaryLabelId = getActiveTemporaryTeamLabelIdForRunner(runnerId);
  for (const labelValue of labels) {
    const labelText = cleanText(labelValue);
    if (!labelText) continue;
    const existingById = one<{ id: string; kind: string }>('SELECT id, kind FROM labels WHERE id = ?', [labelText]);
    const label = existingById || ensureLabel(labelText);
    if (!label) continue;
    if (label.kind === TEMPORARY_TEAM_KIND && label.id !== activeTemporaryLabelId) continue;
    run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [runnerId, label.id]);
  }
}

export function insertRunner(input: RunnerInput): Runner {
  const name = cleanText(input.name);
  if (!name) throw new Error('runner name required');

  const now = Date.now();
  const id = input.id || uuidv4();
  const initialStatus = cleanStatus(input.status);
  if (initialStatus === 'running') {
    throw new Error('Start een nieuwe loper via het timingscherm');
  }
  const initialQueueIndex = initialStatus === 'waiting' ? getMaxQueueIndex() + 1 : null;
  transaction(() => {
    run(
      `INSERT INTO runners (
        id,
        runner_number,
        name,
        target_laps,
        historical_avg_ms,
        historical_best_ms,
        registration_source,
        notes,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        cleanText(input.runnerNumber),
        name,
        cleanInt(input.targetLaps),
        cleanInt(input.historicalAvgMs),
        cleanInt(input.historicalBestMs),
        cleanRegistrationSource(input.registrationSource),
        cleanText(input.notes) || '',
        now,
        now,
      ]
    );
    run(
      `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
       VALUES (?, ?, ?, ?, NULL)`,
      [id, initialStatus, initialQueueIndex, cleanInt(input.statusSince) ?? now]
    );
    setRunnerLabels(id, input.labels || []);
  });
  const runner = getRunnerById(id);
  if (!runner) throw new Error('runner insert failed');
  return runner;
}

export function updateRunner(id: string, fields: RunnerPatch): Runner | null {
  const current = one<{
    runner_number: string | null;
    name: string;
    target_laps: number | null;
    historical_avg_ms: number | null;
    historical_best_ms: number | null;
    registration_source: RegistrationSource;
    notes: string | null;
  }>('SELECT * FROM runners WHERE id = ?', [id]);
  if (!current) return null;

  if (fields.labels !== undefined) {
    const activeTemporaryLabelId = getActiveTemporaryTeamLabelIdForRunner(id);
    if (activeTemporaryLabelId) {
      const requested = new Set(fields.labels.map((value) => String(value)));
      const hasOrdinarySpeedteam = getLabels().some(
        (label) => label.kind === 'speedteam' && requested.has(label.id)
      );
      if (!requested.has(activeTemporaryLabelId) || hasOrdinarySpeedteam) {
        throw new Error('De speedteamploeg ligt vast zolang de tijdelijke nachtploeg actief is');
      }
    }
  }

  const next = {
    runnerNumber: fields.runnerNumber !== undefined ? cleanText(fields.runnerNumber) : current.runner_number,
    name: fields.name !== undefined ? cleanText(fields.name) || current.name : current.name,
    targetLaps: fields.targetLaps !== undefined ? cleanInt(fields.targetLaps) : current.target_laps,
    historicalAvgMs:
      fields.historicalAvgMs !== undefined ? cleanInt(fields.historicalAvgMs) : current.historical_avg_ms,
    historicalBestMs:
      fields.historicalBestMs !== undefined ? cleanInt(fields.historicalBestMs) : current.historical_best_ms,
    registrationSource:
      fields.registrationSource !== undefined
        ? cleanRegistrationSource(fields.registrationSource)
        : cleanRegistrationSource(current.registration_source),
    notes: fields.notes !== undefined ? cleanText(fields.notes) || '' : current.notes || '',
    updatedAt: Date.now(),
  };

  transaction(() => {
    run(
      `UPDATE runners
       SET runner_number = ?,
           name = ?,
           target_laps = ?,
           historical_avg_ms = ?,
           historical_best_ms = ?,
           registration_source = ?,
           notes = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        next.runnerNumber,
        next.name,
        next.targetLaps,
        next.historicalAvgMs,
        next.historicalBestMs,
        next.registrationSource,
        next.notes,
        next.updatedAt,
        id,
      ]
    );
    if (fields.labels !== undefined) {
      setRunnerLabels(id, fields.labels);
    }
  });

  return getRunnerById(id);
}

export function upsertRunnerFromImport(input: RunnerInput): { action: 'created' | 'updated'; runner: Runner } {
  const runnerNumber = cleanText(input.runnerNumber);
  const existing = runnerNumber ? findRunnerByNumber(runnerNumber) : null;
  if (existing) {
    const { status: _status, statusSince: _statusSince, ...profileFields } = input;
    const runner = updateRunner(existing.id, profileFields);
    if (!runner) throw new Error('runner update failed');
    return { action: 'updated', runner };
  }
  return {
    action: 'created',
    runner: insertRunner({
      ...input,
      status: 'registered',
      registrationSource: 'import',
    }),
  };
}

export function deleteRunner(id: string): void {
  transaction(() => {
    run('DELETE FROM runner_labels WHERE runner_id = ?', [id]);
    run('DELETE FROM laps WHERE runner_id = ?', [id]);
    run('DELETE FROM queue_entries WHERE runner_id = ?', [id]);
    run(
      `UPDATE race_state
       SET active_runner_id = NULL, active_started_at = NULL, active_labels_json = NULL
       WHERE active_runner_id = ?`,
      [id]
    );
    run('DELETE FROM runners WHERE id = ?', [id]);
  });
}

export function hideRunnerInQueue(id: string, hiddenAt = Date.now()): Runner | null {
  const now = cleanInt(hiddenAt) ?? Date.now();
  run(
    `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
     VALUES (?, 'registered', NULL, ?, ?)
     ON CONFLICT(runner_id) DO UPDATE SET
       hidden_at = excluded.hidden_at`,
    [id, now, now]
  );
  return getRunnerById(id);
}

export function unhideRunnerInQueue(id: string): Runner | null {
  run(
    `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
     VALUES (?, 'registered', NULL, ?, NULL)
     ON CONFLICT(runner_id) DO UPDATE SET
       hidden_at = NULL`,
    [id, Date.now()]
  );
  return getRunnerById(id);
}

export function updateRunnerStatus({
  id,
  status,
  statusSince,
  queueIndex,
}: {
  id: string;
  status: RunnerStatus;
  statusSince?: number | null;
  queueIndex?: number | null;
}): Runner | null {
  if (!one<{ id: string }>('SELECT id FROM runners WHERE id = ?', [id])) return null;
  const nextStatus = cleanStatus(status);
  if (nextStatus === 'running') {
    const activeRunnerId = getRaceState().activeRunnerId;
    if (activeRunnerId && activeRunnerId !== id) {
      throw new Error('Er loopt al een loper');
    }
  }
  const now = cleanInt(statusSince) ?? Date.now();
  const nextQueueIndex =
    nextStatus === 'waiting'
      ? queueIndex !== undefined && queueIndex !== null
        ? cleanInt(queueIndex)
        : getMaxQueueIndex() + 1
      : null;

  transaction(() => {
    run(
      `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(runner_id) DO UPDATE SET
         status = excluded.status,
         queue_index = excluded.queue_index,
         status_since = excluded.status_since,
         hidden_at = NULL`,
      [id, nextStatus, nextQueueIndex, now]
    );

    if (nextStatus === 'running') {
      run(
        `UPDATE race_state
         SET active_runner_id = ?,
             active_started_at = ?,
             race_started_at = COALESCE(race_started_at, ?),
             race_finished_at = NULL,
             active_labels_json = ?
         WHERE id = 1`,
        [id, now, now, JSON.stringify(getRunnerLabels(id))]
      );
    } else {
      run(
        `UPDATE race_state
         SET active_runner_id = NULL,
             active_started_at = NULL,
             active_labels_json = NULL
         WHERE id = 1 AND active_runner_id = ?`,
        [id]
      );
    }
  });

  return getRunnerById(id);
}

export function updateWaitingOrder(idOrder: string[]): void {
  const uniqueIds = new Set(idOrder);
  const waitingIds = all<{ id: string }>(
    `SELECT runner_id AS id
     FROM queue_entries
     WHERE status = 'waiting'`
  ).map((entry) => entry.id);

  if (
    uniqueIds.size !== idOrder.length ||
    uniqueIds.size !== waitingIds.length ||
    waitingIds.some((id) => !uniqueIds.has(id))
  ) {
    throw new Error('De volledige wachtrijvolgorde is vereist');
  }

  const now = Date.now();
  transaction(() => {
    idOrder.forEach((id, idx) => {
      run(
        `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
         VALUES (?, 'waiting', ?, ?, NULL)
         ON CONFLICT(runner_id) DO UPDATE SET
           status = 'waiting',
           queue_index = excluded.queue_index,
           status_since = COALESCE(queue_entries.status_since, excluded.status_since),
           hidden_at = NULL`,
        [id, idx, now]
      );
    });
  });
}

export function getMaxQueueIndex(): number {
  const row = one<{ maxIdx: number | null }>("SELECT MAX(queue_index) AS maxIdx FROM queue_entries WHERE status = 'waiting'");
  return typeof row?.maxIdx === 'number' ? row.maxIdx : -1;
}

function getQueueEntriesByRunnerIds(ids: string[]): QueueEntrySnapshot[] {
  if (!ids.length) return [];
  return ids
    .map((id) =>
      one<QueueEntrySnapshot>(
        `SELECT
           runner_id AS runnerId,
           status,
           queue_index AS queueIndex,
           status_since AS statusSince,
           hidden_at AS hiddenAt
         FROM queue_entries
         WHERE runner_id = ?`,
        [id]
      )
    )
    .filter((entry): entry is QueueEntrySnapshot => Boolean(entry));
}

function getNextWaitingRunner(): { id: string; name: string } | null {
  return one<{ id: string; name: string }>(
    `SELECT r.id, r.name
     FROM runners r
     JOIN queue_entries q ON q.runner_id = r.id
     WHERE q.status = 'waiting'
     ORDER BY q.queue_index ASC, q.status_since ASC
     LIMIT 1`
  );
}

function getLapCount(runnerId: string): number {
  const row = one<{ count: number }>('SELECT COUNT(*) AS count FROM laps WHERE runner_id = ?', [runnerId]);
  return Number(row?.count || 0);
}

export function getRaceState(): RaceState {
  const row = one<Omit<RaceState, 'id' | 'activeLabels'> & { id: 1; activeLabelsJson: string | null }>(
    `SELECT
      id,
      active_runner_id AS activeRunnerId,
      active_started_at AS activeStartedAt,
      race_started_at AS raceStartedAt,
      race_finished_at AS raceFinishedAt,
      active_labels_json AS activeLabelsJson
     FROM race_state
     WHERE id = 1`
  );
  return {
    id: 1,
    activeRunnerId: row?.activeRunnerId ?? null,
    activeStartedAt: row?.activeStartedAt ?? null,
    raceStartedAt: row?.raceStartedAt ?? null,
    raceFinishedAt: row?.raceFinishedAt ?? null,
    activeLabels: parseLabelsJson(row?.activeLabelsJson),
  };
}

type LapRow = Omit<LapRecord, 'labels'> & { labelsJson: string };

const LAP_SELECT_SQL = `
  SELECT
    l.id,
    l.runner_id AS runnerId,
    r.runner_number AS runnerNumber,
    r.name AS runnerName,
    l.lap_number AS lapNumber,
    l.started_at AS startedAt,
    l.finished_at AS finishedAt,
    l.duration_ms AS durationMs,
    l.source,
    l.created_at AS createdAt,
    l.labels_json AS labelsJson
  FROM laps l
  JOIN runners r ON r.id = l.runner_id
`;

function lapFromRow({ labelsJson, ...lap }: LapRow): LapRecord {
  return { ...lap, labels: parseLabelsJson(labelsJson) };
}

export function getAllLaps(): LapRecord[] {
  return all<LapRow>(`${LAP_SELECT_SQL} ORDER BY l.finished_at DESC`).map(lapFromRow);
}

export function getLapById(id: string): LapRecord | null {
  const row = one<LapRow>(`${LAP_SELECT_SQL} WHERE l.id = ?`, [id]);
  return row ? lapFromRow(row) : null;
}

function cleanRaceEventType(type: unknown): RaceEventType {
  return VALID_RACE_EVENT_TYPES.has(type as RaceEventType) ? (type as RaceEventType) : 'burgie_gepakt';
}

export function getAllRaceEvents(): RaceEvent[] {
  return all<RaceEvent>(
    `SELECT
      id,
      type,
      message,
      occurred_at AS occurredAt,
      created_at AS createdAt,
      runner_id AS runnerId,
      runner_number AS runnerNumber,
      runner_name AS runnerName
    FROM race_events
    ORDER BY occurred_at DESC, created_at DESC`
  ).map((event) => ({
    ...event,
    type: cleanRaceEventType(event.type),
    runnerId: event.runnerId ?? null,
    runnerNumber: event.runnerNumber ?? null,
    runnerName: event.runnerName ?? null,
  }));
}

export function getRaceEventById(id: string): RaceEvent | null {
  const event = one<RaceEvent>(
    `SELECT
       id,
       type,
       message,
       occurred_at AS occurredAt,
       created_at AS createdAt,
       runner_id AS runnerId,
       runner_number AS runnerNumber,
       runner_name AS runnerName
     FROM race_events
     WHERE id = ?`,
    [id]
  );
  return event
    ? {
        ...event,
        type: cleanRaceEventType(event.type),
        runnerId: event.runnerId ?? null,
        runnerNumber: event.runnerNumber ?? null,
        runnerName: event.runnerName ?? null,
      }
    : null;
}

export function createBurgieGepaktEvent(nowMs = Date.now()): RaceEvent {
  const activeRunnerId = getRaceState().activeRunnerId;
  const activeRunner = activeRunnerId ? getRunnerById(activeRunnerId) : null;
  const id = uuidv4();
  const message = 'Burgie gepakt';
  run(
    `INSERT INTO race_events (
      id,
      type,
      message,
      occurred_at,
      runner_id,
      runner_number,
      runner_name,
      created_at
    ) VALUES (?, 'burgie_gepakt', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      message,
      nowMs,
      activeRunner?.id ?? null,
      activeRunner?.runnerNumber ?? null,
      activeRunner?.name ?? null,
      nowMs,
    ]
  );
  const event = getRaceEventById(id);
  if (!event) throw new Error('race event insert failed');
  return event;
}

type QueueEntrySnapshot = {
  runnerId: string;
  status: RunnerStatus;
  queueIndex: number | null;
  statusSince: number | null;
  hiddenAt: number | null;
};

type HandoffSnapshot = {
  raceState: RaceState;
  queueEntries: QueueEntrySnapshot[];
  lapIds: string[];
};

export function performHandoff(nowMs = Date.now()):
  | { ok: true; lapId: string | null; startedRunnerId: string | null }
  | { ok: false; error: 'empty_queue' } {
  const raceState = getRaceState();
  const activeRunnerId = raceState.activeRunnerId;
  const nextRunner = getNextWaitingRunner();

  if (!activeRunnerId && !nextRunner) {
    return { ok: false, error: 'empty_queue' };
  }

  const lapId = activeRunnerId ? uuidv4() : null;
  const affectedIds = [activeRunnerId, nextRunner?.id].filter((id): id is string => Boolean(id));
  const snapshot: HandoffSnapshot = {
    raceState,
    queueEntries: getQueueEntriesByRunnerIds(affectedIds),
    lapIds: lapId ? [lapId] : [],
  };
  const historyId = uuidv4();

  transaction(() => {
    run(
      `INSERT INTO handoff_history (id, created_at, payload_json, undone)
       VALUES (?, ?, ?, 0)`,
      [historyId, nowMs, JSON.stringify(snapshot)]
    );

    if (activeRunnerId) {
      const startedAt = raceState.activeStartedAt ?? nowMs;
      const lapNumber = getLapCount(activeRunnerId) + 1;
      run(
        `INSERT INTO laps (
          id,
          runner_id,
          lap_number,
          started_at,
          finished_at,
          duration_ms,
          source,
          created_at,
          labels_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'spacebar', ?, ?)`,
        [
          lapId,
          activeRunnerId,
          lapNumber,
          startedAt,
          nowMs,
          Math.max(0, nowMs - startedAt),
          nowMs,
          JSON.stringify(raceState.activeLabels.length ? raceState.activeLabels : getRunnerLabels(activeRunnerId)),
        ]
      );
      run(
        `UPDATE queue_entries
         SET status = 'ran', queue_index = NULL, status_since = ?, hidden_at = NULL
         WHERE runner_id = ?`,
        [nowMs, activeRunnerId]
      );
    }

    if (nextRunner) {
      run(
        `UPDATE queue_entries
         SET status = 'running', queue_index = NULL, status_since = ?, hidden_at = NULL
         WHERE runner_id = ?`,
        [nowMs, nextRunner.id]
      );
      run(
        `UPDATE race_state
         SET active_runner_id = ?,
             active_started_at = ?,
             race_started_at = COALESCE(race_started_at, ?),
             race_finished_at = NULL,
             active_labels_json = ?
         WHERE id = 1`,
        [nextRunner.id, nowMs, nowMs, JSON.stringify(getRunnerLabels(nextRunner.id))]
      );
    } else {
      run(
        `UPDATE race_state
         SET active_runner_id = NULL,
             active_started_at = NULL,
             active_labels_json = NULL
         WHERE id = 1`
      );
    }
  });

  return { ok: true, lapId, startedRunnerId: nextRunner?.id ?? null };
}

export function undoLastHandoff(): { ok: true; deletedLapIds: string[] } | { ok: false; error: 'nothing_to_undo' } {
  const row = one<{ id: string; payloadJson: string }>(
    `SELECT id, payload_json AS payloadJson
     FROM handoff_history
     WHERE undone = 0
     ORDER BY created_at DESC
     LIMIT 1`
  );
  if (!row) {
    return { ok: false, error: 'nothing_to_undo' };
  }

  const payload = JSON.parse(row.payloadJson) as HandoffSnapshot;
  const deletedLapIds = payload.lapIds || [];
  transaction(() => {
    for (const lapId of deletedLapIds) {
      run('DELETE FROM laps WHERE id = ?', [lapId]);
    }

    for (const entry of payload.queueEntries || []) {
      run(
        `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(runner_id) DO UPDATE SET
           status = excluded.status,
           queue_index = excluded.queue_index,
           status_since = excluded.status_since,
           hidden_at = excluded.hidden_at`,
        [
          entry.runnerId,
          cleanStatus(entry.status),
          entry.queueIndex ?? null,
          entry.statusSince ?? null,
          entry.hiddenAt ?? null,
        ]
      );
    }

    const raceState = payload.raceState || {};
    run(
      `UPDATE race_state
       SET active_runner_id = ?,
           active_started_at = ?,
           race_started_at = ?,
           race_finished_at = ?,
           active_labels_json = ?
       WHERE id = 1`,
      [
        raceState.activeRunnerId ?? null,
        raceState.activeStartedAt ?? null,
        raceState.raceStartedAt ?? null,
        raceState.raceFinishedAt ?? null,
        JSON.stringify(raceState.activeLabels ?? []),
      ]
    );
    run('UPDATE handoff_history SET undone = 1 WHERE id = ?', [row.id]);
  });

  return { ok: true, deletedLapIds };
}

export function finishRace(nowMs = Date.now()): void {
  const activeRunnerId = getRaceState().activeRunnerId;
  transaction(() => {
    if (activeRunnerId) {
      run(
        `UPDATE queue_entries
         SET status = 'ran', queue_index = NULL, status_since = ?, hidden_at = NULL
         WHERE runner_id = ?`,
        [nowMs, activeRunnerId]
      );
    }
    run(
      `UPDATE race_state
       SET active_runner_id = NULL,
           active_started_at = NULL,
           active_labels_json = NULL,
           race_finished_at = ?
       WHERE id = 1`,
      [nowMs]
    );
  });
}

export function applySnapshot(snapshot: AppSnapshot): void {
  transaction(() => {
    run('DELETE FROM handoff_history');
    run('DELETE FROM race_events');
    run('DELETE FROM laps');
    run('DELETE FROM temporary_team_members');
    run('DELETE FROM temporary_teams');
    run('DELETE FROM runner_labels');
    run('DELETE FROM queue_entries');
    run('DELETE FROM runners');
    run('DELETE FROM labels');

    for (const label of snapshot.labels) {
      run(
        `INSERT INTO labels (
          id,
          name,
          color,
          icon,
          kind,
          image_url,
          target_laps,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          label.id,
          label.name,
          label.color,
          label.icon,
          label.kind,
          label.imageUrl ?? null,
          label.targetLaps ?? null,
          label.sortOrder ?? null,
          label.createdAt ?? Date.now(),
          label.updatedAt ?? Date.now(),
        ]
      );
    }

    for (const runner of snapshot.runners) {
      run(
        `INSERT INTO runners (
          id,
          runner_number,
          name,
          target_laps,
          historical_avg_ms,
          historical_best_ms,
          registration_source,
          notes,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          runner.id,
          runner.runnerNumber ?? null,
          runner.name,
          runner.targetLaps ?? null,
          runner.historicalAvgMs ?? null,
          runner.historicalBestMs ?? null,
          cleanRegistrationSource(runner.registrationSource),
          runner.notes ?? '',
          runner.createdAt,
          runner.updatedAt,
        ]
      );
      run(
        `INSERT INTO queue_entries (
          runner_id,
          status,
          queue_index,
          status_since,
          hidden_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          runner.id,
          cleanStatus(runner.status),
          runner.queueIndex ?? null,
          runner.statusSince ?? null,
          runner.queueHiddenAt ?? null,
        ]
      );
      for (const label of runner.labels || []) {
        run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [
          runner.id,
          label.id,
        ]);
      }
    }

    for (const lap of snapshot.laps.slice().reverse()) {
      run(
        `INSERT INTO laps (
          id,
          runner_id,
          lap_number,
          started_at,
          finished_at,
          duration_ms,
          source,
          created_at,
          labels_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lap.id,
          lap.runnerId,
          lap.lapNumber,
          lap.startedAt,
          lap.finishedAt,
          lap.durationMs,
          lap.source,
          lap.createdAt,
          JSON.stringify(lap.labels ?? []),
        ]
      );
    }

    for (const team of snapshot.temporaryTeams ?? []) {
      run(
        `INSERT INTO temporary_teams (label_id, active, activated_at)
         VALUES (?, ?, ?)`,
        [team.labelId, team.active ? 1 : 0, team.activatedAt ?? null]
      );
      for (const runnerId of team.memberRunnerIds) {
        run(
          `INSERT INTO temporary_team_members (
             team_label_id, runner_id, restore_label_ids_json
           ) VALUES (?, ?, ?)`,
          [team.labelId, runnerId, JSON.stringify(team.restoreLabelIdsByRunner?.[runnerId] ?? [])]
        );
      }
    }

    for (const event of snapshot.events.slice().reverse()) {
      run(
        `INSERT INTO race_events (
          id,
          type,
          message,
          occurred_at,
          runner_id,
          runner_number,
          runner_name,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.id,
          cleanRaceEventType(event.type),
          event.message,
          event.occurredAt,
          event.runnerId ?? null,
          event.runnerNumber ?? null,
          event.runnerName ?? null,
          event.createdAt,
        ]
      );
    }

    run(
      `UPDATE race_state
       SET active_runner_id = ?,
           active_started_at = ?,
           race_started_at = ?,
           race_finished_at = ?,
           active_labels_json = ?
       WHERE id = 1`,
      [
        snapshot.race.activeRunnerId ?? null,
        snapshot.race.activeStartedAt ?? null,
        snapshot.race.raceStartedAt ?? null,
        snapshot.race.raceFinishedAt ?? null,
        JSON.stringify(snapshot.race.activeLabels ?? []),
      ]
    );
    setPublicRecordMode(snapshot.settings?.publicRecordMode ?? DEFAULT_PUBLIC_RECORD_MODE);
  });
}
