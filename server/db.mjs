import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';

let db;

const DATA_DIR = process.env.DATA_PATH 
  ? path.resolve(process.env.DATA_PATH, 'data')
  : path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
  }
}

export async function initDb() {
  ensureDataDir();
  
  const SQL = await initSqlJs();
  
  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
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
  
  saveDb();
}

export function getSetting(key) {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  stmt.bind([key]);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row.value;
  }
  stmt.free();
  return null;
}

export function setSetting(key, value) {
  db.run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, value]);
  saveDb();
}

export function getAllRunners() {
  const stmt = db.prepare('SELECT id, name, status, status_since as statusSince, queue_index as queueIndex FROM runners');
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

export function insertRunner({ id, name, status, statusSince, queueIndex }) {
  db.run('INSERT INTO runners(id, name, status, status_since, queue_index) VALUES(?,?,?,?,?)',
    [id, name, status, statusSince ?? null, queueIndex ?? null]);
  saveDb();
}

export function updateRunnerStatus({ id, status, statusSince, queueIndex }) {
  db.run('UPDATE runners SET status = ?, status_since = ?, queue_index = ? WHERE id = ?',
    [status, statusSince ?? null, queueIndex ?? null, id]);
  saveDb();
}

export function updateWaitingOrder(idOrder) {
  idOrder.forEach((id, idx) => {
    db.run('UPDATE runners SET queue_index = ? WHERE id = ?', [idx, id]);
  });
  saveDb();
}

export function deleteRunner(id) {
  db.run('DELETE FROM runners WHERE id = ?', [id]);
  saveDb();
}

export function getMaxQueueIndex() {
  const stmt = db.prepare("SELECT MAX(queue_index) as maxIdx FROM runners WHERE status = 'waiting'");
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return typeof row.maxIdx === 'number' ? row.maxIdx : -1;
  }
  stmt.free();
  return -1;
}