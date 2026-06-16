import Database from 'better-sqlite3';
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
} from '../shared/schemas.js';

type SqlValue = string | number | null;
type Db = Database.Database;

const DATA_DIR = process.env.DATA_PATH
  ? path.resolve(process.env.DATA_PATH, 'data')
  : path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

const VALID_STATUSES = new Set<RunnerStatus>(['registered', 'warming_up', 'waiting', 'running', 'ran']);
const VALID_REGISTRATION_SOURCES = new Set<RegistrationSource>(['import', 'manual']);
const VALID_RACE_EVENT_TYPES = new Set<RaceEventType>(['burgie_gepakt']);
const VALID_PUBLIC_RECORD_MODES = new Set<PublicRecordMode>(['off', 'day', 'two_hour', 'hour']);
const DEFAULT_PUBLIC_RECORD_MODE: PublicRecordMode = 'day';

const DEFAULT_LABELS: LabelInput[] = [
  {
    name: 'Speedteam White',
    color: '#e5e7eb',
    icon: 'SW',
    kind: 'speedteam',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 10,
  },
  {
    name: 'Speedteam Blue',
    color: '#1d4ed8',
    icon: 'SB',
    kind: 'speedteam',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 20,
  },
  {
    name: 'HILOK',
    color: '#16a34a',
    icon: 'HI',
    kind: 'zustervereniging',
    imageUrl: '/labels/hilok.png',
    targetLaps: null,
    sortOrder: 30,
  },
  {
    name: 'Mesacosa',
    color: '#f97316',
    icon: 'ME',
    kind: 'zustervereniging',
    imageUrl: '/labels/mesacosa.jpg',
    targetLaps: null,
    sortOrder: 40,
  },
  {
    name: 'Kinesia',
    color: '#7c3aed',
    icon: 'KI',
    kind: 'zustervereniging',
    imageUrl: '/labels/kinesia.png',
    targetLaps: null,
    sortOrder: 50,
  },
  {
    name: '1ste jaar',
    color: '#2563eb',
    icon: '1J',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 60,
  },
  {
    name: 'Anciens',
    color: '#64748b',
    icon: 'AN',
    kind: 'andere',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 70,
  },
  {
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
  return getDb().prepare(sql).run(...params);
}

function all<T>(sql: string, params: SqlValue[] = []): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

function one<T>(sql: string, params: SqlValue[] = []): T | null {
  return getDb().prepare(sql).get(...params) as T | undefined ?? null;
}

function transaction<T>(callback: () => T): T {
  return getDb().transaction(callback)();
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

    CREATE TABLE IF NOT EXISTS cluster_operations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      term INTEGER NOT NULL,
      origin_host_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      applied_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cluster_operations_created_at
      ON cluster_operations(created_at);
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

function seedDefaultLabels(): void {
  const now = Date.now();
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
             sort_order = COALESCE(sort_order, ?),
             updated_at = ?
         WHERE id = ?`,
        [
          label.color ?? '#3b82f6',
          label.icon ?? label.name.slice(0, 2).toUpperCase(),
          label.kind ?? 'custom',
          label.imageUrl ?? null,
          label.targetLaps ?? null,
          label.sortOrder ?? null,
          now,
          existing.id,
        ]
      );
      continue;
    }
    createLabel(label);
  }
}

export async function initDb(): Promise<void> {
  ensureDataDir();
  if (database) database.close();
  database = new Database(DB_FILE);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('busy_timeout = 5000');
  createSchema();
  seedDefaultLabels();
  setSetting('schema_version', '4');
  ensureHostId();
}

export function getSetting(key: string): string | null {
  const row = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, String(value)]);
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

export function getClusterTerm(): number {
  return Number(getSetting('cluster_term') || 0);
}

export function setClusterTerm(term: number): void {
  setSetting('cluster_term', String(Math.max(0, Math.floor(term))));
}

export function getClusterVotedFor(): string | null {
  return getSetting('cluster_voted_for');
}

export function setClusterVotedFor(hostId: string | null): void {
  if (hostId) {
    setSetting('cluster_voted_for', hostId);
    return;
  }
  run('DELETE FROM settings WHERE key = ?', ['cluster_voted_for']);
}

export type ClusterOperation = {
  seq: number;
  id: string;
  term: number;
  originHostId: string;
  type: string;
  payload: unknown;
  createdAt: number;
  appliedAt: number;
};

export function appendClusterOperation(input: {
  seq?: number;
  id?: string;
  term: number;
  originHostId: string;
  type: string;
  payload: unknown;
  createdAt?: number;
  appliedAt?: number;
}): ClusterOperation {
  const now = Date.now();
  const id = input.id || uuidv4();
  if (input.seq !== undefined) {
    run(
      `INSERT OR IGNORE INTO cluster_operations (
        seq,
        id,
        term,
        origin_host_id,
        type,
        payload_json,
        created_at,
        applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Math.max(1, Math.floor(input.seq)),
        id,
        Math.max(0, Math.floor(input.term)),
        input.originHostId,
        input.type,
        JSON.stringify(input.payload),
        input.createdAt ?? now,
        input.appliedAt ?? now,
      ]
    );
  } else {
    run(
      `INSERT OR IGNORE INTO cluster_operations (
        id,
        term,
        origin_host_id,
        type,
        payload_json,
        created_at,
        applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        Math.max(0, Math.floor(input.term)),
        input.originHostId,
        input.type,
        JSON.stringify(input.payload),
        input.createdAt ?? now,
        input.appliedAt ?? now,
      ]
    );
  }
  const row = one<{
    seq: number;
    id: string;
    term: number;
    originHostId: string;
    type: string;
    payloadJson: string;
    createdAt: number;
    appliedAt: number;
  }>(
    `SELECT
       seq,
       id,
       term,
       origin_host_id AS originHostId,
       type,
       payload_json AS payloadJson,
       created_at AS createdAt,
       applied_at AS appliedAt
     FROM cluster_operations
     WHERE id = ?`,
    [id]
  );
  if (!row) throw new Error('cluster operation insert failed');
  return {
    seq: row.seq,
    id: row.id,
    term: row.term,
    originHostId: row.originHostId,
    type: row.type,
    payload: JSON.parse(row.payloadJson) as unknown,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  };
}

export function getLastClusterOperationSeq(): number {
  const row = one<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM cluster_operations');
  return Number(row?.seq || 0);
}

export function getClusterOperationsAfter(seq: number, limit = 250): ClusterOperation[] {
  return all<{
    seq: number;
    id: string;
    term: number;
    originHostId: string;
    type: string;
    payloadJson: string;
    createdAt: number;
    appliedAt: number;
  }>(
    `SELECT
       seq,
       id,
       term,
       origin_host_id AS originHostId,
       type,
       payload_json AS payloadJson,
       created_at AS createdAt,
       applied_at AS appliedAt
     FROM cluster_operations
     WHERE seq > ?
     ORDER BY seq ASC
     LIMIT ?`,
    [Math.max(0, Math.floor(seq)), Math.max(1, Math.floor(limit))]
  ).map((row) => ({
    seq: row.seq,
    id: row.id,
    term: row.term,
    originHostId: row.originHostId,
    type: row.type,
    payload: JSON.parse(row.payloadJson) as unknown,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  }));
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
     WHERE lower(name) = ?`,
    [normalized]
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

export function createLabel(input: LabelInput): Label {
  const labelName = cleanText(input.name);
  if (!labelName) throw new Error('label name required');
  const now = Date.now();
  const label = {
    id: uuidv4(),
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
  return { ...label, createdAt: now, updatedAt: now };
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

  return getLabels().find((label) => label.id === id) ?? null;
}

export function deleteLabel(id: string): void {
  transaction(() => {
    run('DELETE FROM runner_labels WHERE label_id = ?', [id]);
    run('DELETE FROM labels WHERE id = ?', [id]);
  });
}

function getRunnerLabelsMap(): Map<string, Label[]> {
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
    ORDER BY COALESCE(l.sort_order, 9999), l.name`
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

export function getAllRunners(): Runner[] {
  const labelsByRunner = getRunnerLabelsMap();
  const rows = all<Omit<Runner, 'labels' | 'hiddenFromQueue'> & { queueHiddenAt: number | null }>(
    `SELECT
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

  return rows.map((row) => ({
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
    labels: labelsByRunner.get(row.id) ?? [],
    lapCount: Number(row.lapCount || 0),
    lastLapMs: row.lastLapMs ?? null,
    bestLapMs: row.bestLapMs ?? null,
    slowestLapMs: row.slowestLapMs ?? null,
    averageLapMs: row.averageLapMs ?? null,
    totalTimeMs: Number(row.totalTimeMs || 0),
  }));
}

export function getRunnerById(id: string): Runner | null {
  return getAllRunners().find((runner) => runner.id === id) ?? null;
}

function findRunnerByNumber(runnerNumber: unknown): { id: string } | null {
  const number = cleanText(runnerNumber);
  if (!number) return null;
  return one<{ id: string }>('SELECT id FROM runners WHERE runner_number = ?', [number]);
}

export function setRunnerLabels(runnerId: string, labelNamesOrIds: unknown): void {
  run('DELETE FROM runner_labels WHERE runner_id = ?', [runnerId]);
  const labels = Array.isArray(labelNamesOrIds) ? labelNamesOrIds : [];
  for (const labelValue of labels) {
    const labelText = cleanText(labelValue);
    if (!labelText) continue;
    const existingById = one<{ id: string }>('SELECT id FROM labels WHERE id = ?', [labelText]);
    const label = existingById || ensureLabel(labelText);
    if (!label) continue;
    run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [runnerId, label.id]);
  }
}

export function insertRunner(input: RunnerInput): Runner {
  const name = cleanText(input.name);
  if (!name) throw new Error('runner name required');

  const now = Date.now();
  const id = input.id || uuidv4();
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
       VALUES (?, ?, NULL, ?, NULL)`,
      [id, cleanStatus(input.status), cleanInt(input.statusSince) ?? now]
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
    run('UPDATE race_state SET active_runner_id = NULL, active_started_at = NULL WHERE active_runner_id = ?', [
      id,
    ]);
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
  const nextStatus = cleanStatus(status);
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
             race_finished_at = NULL
         WHERE id = 1`,
        [id, now, now]
      );
    } else {
      run(
        `UPDATE race_state
         SET active_runner_id = NULL,
             active_started_at = NULL
         WHERE id = 1 AND active_runner_id = ?`,
        [id]
      );
    }
  });

  return getRunnerById(id);
}

export function updateWaitingOrder(idOrder: string[]): void {
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
  const row = one<Omit<RaceState, 'id'> & { id: 1 }>(
    `SELECT
      id,
      active_runner_id AS activeRunnerId,
      active_started_at AS activeStartedAt,
      race_started_at AS raceStartedAt,
      race_finished_at AS raceFinishedAt
     FROM race_state
     WHERE id = 1`
  );
  return {
    id: 1,
    activeRunnerId: row?.activeRunnerId ?? null,
    activeStartedAt: row?.activeStartedAt ?? null,
    raceStartedAt: row?.raceStartedAt ?? null,
    raceFinishedAt: row?.raceFinishedAt ?? null,
  };
}

export function getAllLaps(): LapRecord[] {
  const labelsByRunner = getRunnerLabelsMap();
  return all<Omit<LapRecord, 'labels'>>(
    `SELECT
      l.id,
      l.runner_id AS runnerId,
      r.runner_number AS runnerNumber,
      r.name AS runnerName,
      l.lap_number AS lapNumber,
      l.started_at AS startedAt,
      l.finished_at AS finishedAt,
      l.duration_ms AS durationMs,
      l.source,
      l.created_at AS createdAt
    FROM laps l
    JOIN runners r ON r.id = l.runner_id
    ORDER BY l.finished_at DESC`
  ).map((lap) => ({
    ...lap,
    labels: labelsByRunner.get(lap.runnerId) ?? [],
  }));
}

export function getLapById(id: string): LapRecord | null {
  return getAllLaps().find((lap) => lap.id === id) ?? null;
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
  return getAllRaceEvents().find((event) => event.id === id) ?? null;
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
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'spacebar', ?)`,
        [lapId, activeRunnerId, lapNumber, startedAt, nowMs, Math.max(0, nowMs - startedAt), nowMs]
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
             race_finished_at = NULL
         WHERE id = 1`,
        [nextRunner.id, nowMs, nowMs]
      );
    } else {
      run(
        `UPDATE race_state
         SET active_runner_id = NULL,
             active_started_at = NULL
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
           race_finished_at = ?
       WHERE id = 1`,
      [
        raceState.activeRunnerId ?? null,
        raceState.activeStartedAt ?? null,
        raceState.raceStartedAt ?? null,
        raceState.raceFinishedAt ?? null,
      ]
    );
    run('UPDATE handoff_history SET undone = 1 WHERE id = ?', [row.id]);
  });

  return { ok: true, deletedLapIds };
}

export function finishRace(nowMs = Date.now()): void {
  run(
    `UPDATE race_state
     SET active_runner_id = NULL,
         active_started_at = NULL,
         race_finished_at = ?
     WHERE id = 1`,
    [nowMs]
  );
}

export function applySnapshot(snapshot: AppSnapshot): void {
  transaction(() => {
    run('DELETE FROM handoff_history');
    run('DELETE FROM race_events');
    run('DELETE FROM laps');
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
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lap.id,
          lap.runnerId,
          lap.lapNumber,
          lap.startedAt,
          lap.finishedAt,
          lap.durationMs,
          lap.source,
          lap.createdAt,
        ]
      );
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
           race_finished_at = ?
       WHERE id = 1`,
      [
        snapshot.race.activeRunnerId ?? null,
        snapshot.race.activeStartedAt ?? null,
        snapshot.race.raceStartedAt ?? null,
        snapshot.race.raceFinishedAt ?? null,
      ]
    );
    setPublicRecordMode(snapshot.settings?.publicRecordMode ?? DEFAULT_PUBLIC_RECORD_MODE);
  });
}
