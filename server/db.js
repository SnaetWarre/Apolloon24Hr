import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

ensureDataDir();

export const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runners (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('warming_up','waiting','ran')),
    status_since INTEGER,
    queue_index INTEGER
  );
`);

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getAllRunners() {
  const rows = db.prepare('SELECT id, name, status, status_since as statusSince, queue_index as queueIndex FROM runners').all();
  return rows;
}

export function insertRunner({ id, name, status, statusSince, queueIndex }) {
  db.prepare('INSERT INTO runners(id, name, status, status_since, queue_index) VALUES(?,?,?,?,?)')
    .run(id, name, status, statusSince ?? null, queueIndex ?? null);
}

export function updateRunnerStatus({ id, status, statusSince, queueIndex }) {
  db.prepare('UPDATE runners SET status = ?, status_since = ?, queue_index = ? WHERE id = ?')
    .run(status, statusSince ?? null, queueIndex ?? null, id);
}

export function updateWaitingOrder(idOrder) {
  const upd = db.prepare('UPDATE runners SET queue_index = ? WHERE id = ?');
  const tx = db.transaction((ids) => {
    ids.forEach((id, idx) => {
      upd.run(idx, id);
    });
  });
  tx(idOrder);
}

export function deleteRunner(id) {
  db.prepare('DELETE FROM runners WHERE id = ?').run(id);
}

export function getMaxQueueIndex() {
  const row = db.prepare("SELECT MAX(queue_index) as maxIdx FROM runners WHERE status = 'waiting'").get();
  return typeof row?.maxIdx === 'number' ? row.maxIdx : -1;
}


