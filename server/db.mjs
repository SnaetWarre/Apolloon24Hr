import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

let db;

const DATA_DIR = process.env.DATA_PATH
  ? path.resolve(process.env.DATA_PATH, 'data')
  : path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

const VALID_STATUSES = new Set(['warming_up', 'waiting', 'running', 'ran']);

const DEFAULT_LABELS = [
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

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function one(sql, params = []) {
  const rows = all(sql, params);
  return rows[0] ?? null;
}

function tableExists(tableName) {
  const row = one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]);
  return Boolean(row);
}

function getTableColumns(tableName) {
  if (!tableExists(tableName)) return [];
  return all(`PRAGMA table_info(${tableName})`).map((row) => String(row.name));
}

function cleanText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function cleanInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function cleanStatus(status) {
  return VALID_STATUSES.has(status) ? status : 'warming_up';
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function canonicalLabelName(name) {
  const text = cleanText(name);
  const normalized = normalizeName(text);
  if (['1ste jaars', '1e jaar', '1e jaars', 'eerste jaar', 'eerste jaars'].includes(normalized)) {
    return '1ste jaar';
  }
  return text;
}

function createSchema() {
  db.run(`
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
      status TEXT NOT NULL CHECK(status IN ('warming_up','waiting','running','ran')),
      queue_index INTEGER,
      status_since INTEGER,
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
  `);

  db.run(`
    INSERT OR IGNORE INTO race_state (
      id,
      active_runner_id,
      active_started_at,
      race_started_at,
      race_finished_at
    ) VALUES (1, NULL, NULL, NULL, NULL)
  `);
}

function migrateLegacyRunnersIfNeeded() {
  const columns = getTableColumns('runners');
  if (!columns.length || !columns.includes('status') || columns.includes('runner_number')) {
    return;
  }

  const legacyTable = `runners_legacy_${Date.now()}`;
  db.run(`ALTER TABLE runners RENAME TO ${legacyTable}`);
  createSchema();

  const now = Date.now();
  const legacyRows = all(
    `SELECT id, name, status, status_since AS statusSince, queue_index AS queueIndex FROM ${legacyTable}`
  );

  for (const row of legacyRows) {
    const id = cleanText(row.id) || uuidv4();
    const name = cleanText(row.name) || 'Onbekende loper';
    const status = cleanStatus(row.status);
    db.run(
      `INSERT OR IGNORE INTO runners (
        id,
        runner_number,
        name,
        target_laps,
        historical_avg_ms,
        historical_best_ms,
        notes,
        created_at,
        updated_at
      ) VALUES (?, NULL, ?, NULL, NULL, NULL, '', ?, ?)`,
      [id, name, now, now]
    );
    db.run(
      `INSERT OR REPLACE INTO queue_entries (runner_id, status, queue_index, status_since)
       VALUES (?, ?, ?, ?)`,
      [
        id,
        status,
        status === 'waiting' ? cleanInt(row.queueIndex) : null,
        cleanInt(row.statusSince) ?? now,
      ]
    );
  }
}

function ensureColumn(tableName, columnName, ddl) {
  const columns = getTableColumns(tableName);
  if (!columns.length || columns.includes(columnName)) return;
  db.run(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
}

function migrateSchemaColumns() {
  ensureColumn('labels', 'image_url', 'image_url TEXT');
  ensureColumn('labels', 'target_laps', 'target_laps INTEGER');
  ensureColumn('labels', 'sort_order', 'sort_order INTEGER');
}

function normalizeDefaultLabelAliases() {
  const oldFirstYear = one(
    `SELECT id FROM labels WHERE lower(name) IN ('1ste jaars', '1e jaar', '1e jaars', 'eerste jaar', 'eerste jaars')`
  );
  const newFirstYear = one(`SELECT id FROM labels WHERE lower(name) = '1ste jaar'`);
  if (oldFirstYear && !newFirstYear) {
    db.run('UPDATE labels SET name = ?, updated_at = ? WHERE id = ?', [
      '1ste jaar',
      Date.now(),
      oldFirstYear.id,
    ]);
  } else if (oldFirstYear && newFirstYear && oldFirstYear.id !== newFirstYear.id) {
    db.run('UPDATE OR IGNORE runner_labels SET label_id = ? WHERE label_id = ?', [
      newFirstYear.id,
      oldFirstYear.id,
    ]);
    db.run('DELETE FROM labels WHERE id = ?', [oldFirstYear.id]);
  }
}

function seedDefaultLabels() {
  const now = Date.now();
  for (const label of DEFAULT_LABELS) {
    const existing = findLabelByName(label.name);
    if (existing) {
      db.run(
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
          label.color,
          label.icon,
          label.kind,
          label.imageUrl,
          label.targetLaps,
          label.sortOrder,
          now,
          existing.id,
        ]
      );
    } else {
      db.run(
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
          uuidv4(),
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
    }
  }
}

export async function initDb() {
  ensureDataDir();

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  migrateLegacyRunnersIfNeeded();
  createSchema();
  migrateSchemaColumns();
  normalizeDefaultLabelAliases();
  seedDefaultLabels();
  setSetting('schema_version', '2');
  saveDb();
}

export function getSetting(key) {
  const row = one('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, String(value)]);
  saveDb();
}

export function getLabels() {
  return all(
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

export function findLabelByName(name) {
  const normalized = normalizeName(canonicalLabelName(name));
  if (!normalized) return null;
  return one(
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

export function ensureLabel(name, options = {}) {
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

export function createLabel({ name, color, icon, kind, imageUrl, targetLaps, sortOrder }) {
  const labelName = cleanText(name);
  if (!labelName) {
    throw new Error('label name required');
  }
  const now = Date.now();
  const label = {
    id: uuidv4(),
    name: labelName,
    color: cleanText(color) || '#3b82f6',
    icon: cleanText(icon) || labelName.slice(0, 2).toUpperCase(),
    kind: cleanText(kind) || 'custom',
    imageUrl: cleanText(imageUrl),
    targetLaps: cleanInt(targetLaps),
    sortOrder: cleanInt(sortOrder),
  };
  db.run(
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
  saveDb();
  return { ...label, createdAt: now, updatedAt: now };
}

export function updateLabel(id, fields) {
  const current = one('SELECT id FROM labels WHERE id = ?', [id]);
  if (!current) return null;
  const existing = one(
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
  const next = {
    name: cleanText(fields.name) || existing.name,
    color: cleanText(fields.color) || existing.color,
    icon: cleanText(fields.icon) || existing.icon,
    kind: cleanText(fields.kind) || existing.kind,
    imageUrl: fields.imageUrl !== undefined ? cleanText(fields.imageUrl) || null : existing.imageUrl,
    targetLaps: fields.targetLaps !== undefined ? cleanInt(fields.targetLaps) : existing.targetLaps,
    sortOrder: fields.sortOrder !== undefined ? cleanInt(fields.sortOrder) : existing.sortOrder,
    updatedAt: Date.now(),
  };
  db.run(
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
  saveDb();
  return getLabels().find((label) => label.id === id) ?? null;
}

export function deleteLabel(id) {
  db.run('DELETE FROM runner_labels WHERE label_id = ?', [id]);
  db.run('DELETE FROM labels WHERE id = ?', [id]);
  saveDb();
}

function getRunnerLabelsMap() {
  const rows = all(
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
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.runnerId)) map.set(row.runnerId, []);
    map.get(row.runnerId).push({
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

export function getAllRunners() {
  const labelsByRunner = getRunnerLabelsMap();
  const rows = all(
    `SELECT
      r.id,
      r.runner_number AS runnerNumber,
      r.name,
      r.target_laps AS targetLaps,
      r.historical_avg_ms AS historicalAvgMs,
      r.historical_best_ms AS historicalBestMs,
      r.notes,
      r.created_at AS createdAt,
      r.updated_at AS updatedAt,
      COALESCE(q.status, 'warming_up') AS status,
      q.status_since AS statusSince,
      q.queue_index AS queueIndex,
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
      CASE COALESCE(q.status, 'warming_up')
        WHEN 'running' THEN 0
        WHEN 'waiting' THEN 1
        WHEN 'warming_up' THEN 2
        ELSE 3
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
    notes: row.notes ?? '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: cleanStatus(row.status),
    statusSince: row.statusSince ?? null,
    queueIndex: row.queueIndex ?? null,
    labels: labelsByRunner.get(row.id) ?? [],
    lapCount: Number(row.lapCount || 0),
    lastLapMs: row.lastLapMs ?? null,
    bestLapMs: row.bestLapMs ?? null,
    slowestLapMs: row.slowestLapMs ?? null,
    averageLapMs: row.averageLapMs ?? null,
    totalTimeMs: Number(row.totalTimeMs || 0),
  }));
}

export function getRunnerById(id) {
  return getAllRunners().find((runner) => runner.id === id) ?? null;
}

function findRunnerByNumber(runnerNumber) {
  const number = cleanText(runnerNumber);
  if (!number) return null;
  return one('SELECT id FROM runners WHERE runner_number = ?', [number]);
}

export function setRunnerLabels(runnerId, labelNamesOrIds) {
  db.run('DELETE FROM runner_labels WHERE runner_id = ?', [runnerId]);
  const labels = Array.isArray(labelNamesOrIds) ? labelNamesOrIds : [];
  for (const labelValue of labels) {
    const labelText = cleanText(labelValue);
    if (!labelText) continue;
    const existingById = one('SELECT id FROM labels WHERE id = ?', [labelText]);
    const label = existingById || ensureLabel(labelText);
    if (!label) continue;
    db.run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [
      runnerId,
      label.id,
    ]);
  }
}

export function insertRunner(input) {
  const name = cleanText(input.name);
  if (!name) throw new Error('runner name required');

  const now = Date.now();
  const id = input.id || uuidv4();
  db.run(
    `INSERT INTO runners (
      id,
      runner_number,
      name,
      target_laps,
      historical_avg_ms,
      historical_best_ms,
      notes,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      cleanText(input.runnerNumber),
      name,
      cleanInt(input.targetLaps),
      cleanInt(input.historicalAvgMs),
      cleanInt(input.historicalBestMs),
      cleanText(input.notes) || '',
      now,
      now,
    ]
  );
  db.run(
    `INSERT INTO queue_entries (runner_id, status, queue_index, status_since)
     VALUES (?, ?, NULL, ?)`,
    [id, cleanStatus(input.status || 'warming_up'), cleanInt(input.statusSince) ?? now]
  );
  setRunnerLabels(id, input.labels || []);
  saveDb();
  return getRunnerById(id);
}

export function updateRunner(id, fields) {
  const current = one('SELECT * FROM runners WHERE id = ?', [id]);
  if (!current) return null;
  const next = {
    runnerNumber:
      fields.runnerNumber !== undefined ? cleanText(fields.runnerNumber) : current.runner_number,
    name: fields.name !== undefined ? cleanText(fields.name) || current.name : current.name,
    targetLaps: fields.targetLaps !== undefined ? cleanInt(fields.targetLaps) : current.target_laps,
    historicalAvgMs:
      fields.historicalAvgMs !== undefined
        ? cleanInt(fields.historicalAvgMs)
        : current.historical_avg_ms,
    historicalBestMs:
      fields.historicalBestMs !== undefined
        ? cleanInt(fields.historicalBestMs)
        : current.historical_best_ms,
    notes: fields.notes !== undefined ? cleanText(fields.notes) || '' : current.notes || '',
    updatedAt: Date.now(),
  };
  db.run(
    `UPDATE runners
     SET runner_number = ?,
         name = ?,
         target_laps = ?,
         historical_avg_ms = ?,
         historical_best_ms = ?,
         notes = ?,
         updated_at = ?
     WHERE id = ?`,
    [
      next.runnerNumber,
      next.name,
      next.targetLaps,
      next.historicalAvgMs,
      next.historicalBestMs,
      next.notes,
      next.updatedAt,
      id,
    ]
  );
  if (fields.labels !== undefined) {
    setRunnerLabels(id, fields.labels);
  }
  saveDb();
  return getRunnerById(id);
}

export function upsertRunnerFromImport(input) {
  const runnerNumber = cleanText(input.runnerNumber);
  const existing = runnerNumber ? findRunnerByNumber(runnerNumber) : null;
  if (existing) {
    return {
      action: 'updated',
      runner: updateRunner(existing.id, input),
    };
  }
  return {
    action: 'created',
    runner: insertRunner(input),
  };
}

export function deleteRunner(id) {
  db.run('DELETE FROM runner_labels WHERE runner_id = ?', [id]);
  db.run('DELETE FROM laps WHERE runner_id = ?', [id]);
  db.run('DELETE FROM queue_entries WHERE runner_id = ?', [id]);
  db.run('UPDATE race_state SET active_runner_id = NULL, active_started_at = NULL WHERE active_runner_id = ?', [
    id,
  ]);
  db.run('DELETE FROM runners WHERE id = ?', [id]);
  saveDb();
}

export function updateRunnerStatus({ id, status, statusSince, queueIndex }) {
  const nextStatus = cleanStatus(status);
  const now = cleanInt(statusSince) ?? Date.now();
  const nextQueueIndex =
    nextStatus === 'waiting'
      ? queueIndex !== undefined && queueIndex !== null
        ? cleanInt(queueIndex)
        : getMaxQueueIndex() + 1
      : null;

  db.run(
    `INSERT INTO queue_entries (runner_id, status, queue_index, status_since)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(runner_id) DO UPDATE SET
       status = excluded.status,
       queue_index = excluded.queue_index,
       status_since = excluded.status_since`,
    [id, nextStatus, nextQueueIndex, now]
  );

  if (nextStatus === 'running') {
    db.run(
      `UPDATE race_state
       SET active_runner_id = ?,
           active_started_at = ?,
           race_started_at = COALESCE(race_started_at, ?),
           race_finished_at = NULL
       WHERE id = 1`,
      [id, now, now]
    );
  } else {
    db.run(
      `UPDATE race_state
       SET active_runner_id = NULL,
           active_started_at = NULL
       WHERE id = 1 AND active_runner_id = ?`,
      [id]
    );
  }
  saveDb();
  return getRunnerById(id);
}

export function updateWaitingOrder(idOrder) {
  const now = Date.now();
  idOrder.forEach((id, idx) => {
    db.run(
      `INSERT INTO queue_entries (runner_id, status, queue_index, status_since)
       VALUES (?, 'waiting', ?, ?)
       ON CONFLICT(runner_id) DO UPDATE SET
         status = 'waiting',
         queue_index = excluded.queue_index,
         status_since = COALESCE(queue_entries.status_since, excluded.status_since)`,
      [id, idx, now]
    );
  });
  saveDb();
}

export function getMaxQueueIndex() {
  const row = one("SELECT MAX(queue_index) AS maxIdx FROM queue_entries WHERE status = 'waiting'");
  return typeof row?.maxIdx === 'number' ? row.maxIdx : -1;
}

function getQueueEntriesByRunnerIds(ids) {
  if (!ids.length) return [];
  return ids
    .map((id) =>
      one(
        `SELECT runner_id AS runnerId, status, queue_index AS queueIndex, status_since AS statusSince
         FROM queue_entries
         WHERE runner_id = ?`,
        [id]
      )
    )
    .filter(Boolean);
}

function getNextWaitingRunner() {
  return one(
    `SELECT r.id, r.name
     FROM runners r
     JOIN queue_entries q ON q.runner_id = r.id
     WHERE q.status = 'waiting'
     ORDER BY q.queue_index ASC, q.status_since ASC
     LIMIT 1`
  );
}

function getLapCount(runnerId) {
  const row = one('SELECT COUNT(*) AS count FROM laps WHERE runner_id = ?', [runnerId]);
  return Number(row?.count || 0);
}

export function getRaceState() {
  const row =
    one(
      `SELECT
        id,
        active_runner_id AS activeRunnerId,
        active_started_at AS activeStartedAt,
        race_started_at AS raceStartedAt,
        race_finished_at AS raceFinishedAt
       FROM race_state
       WHERE id = 1`
    ) || {};
  return {
    id: 1,
    activeRunnerId: row.activeRunnerId ?? null,
    activeStartedAt: row.activeStartedAt ?? null,
    raceStartedAt: row.raceStartedAt ?? null,
    raceFinishedAt: row.raceFinishedAt ?? null,
  };
}

export function getAllLaps() {
  const labelsByRunner = getRunnerLabelsMap();
  return all(
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

export function performHandoff(nowMs = Date.now()) {
  const raceState = getRaceState();
  const activeRunnerId = raceState.activeRunnerId;
  const nextRunner = getNextWaitingRunner();

  // Opening the app never starts the race. The first timing handoff starts the race clock
  // and marks the first queued runner as active; later handoffs record laps and advance.
  if (!activeRunnerId && !nextRunner) {
    return { ok: false, error: 'empty_queue' };
  }

  const lapId = activeRunnerId ? uuidv4() : null;
  const affectedIds = [activeRunnerId, nextRunner?.id].filter(Boolean);
  const snapshot = {
    raceState,
    queueEntries: getQueueEntriesByRunnerIds(affectedIds),
    lapIds: lapId ? [lapId] : [],
  };
  const historyId = uuidv4();

  try {
    db.run('BEGIN TRANSACTION');
    db.run(
      `INSERT INTO handoff_history (id, created_at, payload_json, undone)
       VALUES (?, ?, ?, 0)`,
      [historyId, nowMs, JSON.stringify(snapshot)]
    );

    if (activeRunnerId) {
      const startedAt = raceState.activeStartedAt ?? nowMs;
      const lapNumber = getLapCount(activeRunnerId) + 1;
      db.run(
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
      db.run(
        `UPDATE queue_entries
         SET status = 'ran', queue_index = NULL, status_since = ?
         WHERE runner_id = ?`,
        [nowMs, activeRunnerId]
      );
    }

    if (nextRunner) {
      db.run(
        `UPDATE queue_entries
         SET status = 'running', queue_index = NULL, status_since = ?
         WHERE runner_id = ?`,
        [nowMs, nextRunner.id]
      );
      db.run(
        `UPDATE race_state
         SET active_runner_id = ?,
             active_started_at = ?,
             race_started_at = COALESCE(race_started_at, ?),
             race_finished_at = NULL
         WHERE id = 1`,
        [nextRunner.id, nowMs, nowMs]
      );
    } else {
      db.run(
        `UPDATE race_state
         SET active_runner_id = NULL,
             active_started_at = NULL
         WHERE id = 1`
      );
    }

    db.run('COMMIT');
    saveDb();
    return { ok: true, lapId, startedRunnerId: nextRunner?.id ?? null };
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  }
}

export function undoLastHandoff() {
  const row = one(
    `SELECT id, payload_json AS payloadJson
     FROM handoff_history
     WHERE undone = 0
     ORDER BY created_at DESC
     LIMIT 1`
  );
  if (!row) {
    return { ok: false, error: 'nothing_to_undo' };
  }

  const payload = JSON.parse(row.payloadJson);
  try {
    db.run('BEGIN TRANSACTION');

    for (const lapId of payload.lapIds || []) {
      db.run('DELETE FROM laps WHERE id = ?', [lapId]);
    }

    for (const entry of payload.queueEntries || []) {
      db.run(
        `INSERT INTO queue_entries (runner_id, status, queue_index, status_since)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(runner_id) DO UPDATE SET
           status = excluded.status,
           queue_index = excluded.queue_index,
           status_since = excluded.status_since`,
        [entry.runnerId, cleanStatus(entry.status), entry.queueIndex ?? null, entry.statusSince ?? null]
      );
    }

    const raceState = payload.raceState || {};
    db.run(
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
    db.run('UPDATE handoff_history SET undone = 1 WHERE id = ?', [row.id]);
    db.run('COMMIT');
    saveDb();
    return { ok: true };
  } catch (err) {
    try {
      db.run('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  }
}

export function finishRace(nowMs = Date.now()) {
  db.run(
    `UPDATE race_state
     SET active_runner_id = NULL,
         active_started_at = NULL,
         race_finished_at = ?
     WHERE id = 1`,
    [nowMs]
  );
  saveDb();
}
