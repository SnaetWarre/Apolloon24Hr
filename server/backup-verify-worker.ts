import { parentPort, workerData } from 'node:worker_threads';
import { openExistingDatabase, quickCheck } from './db/sqlite-file.js';

// Runs off the main thread so integrity checks never delay a timing request.
const { filePath } = workerData as { filePath: string };

try {
  const backup = openExistingDatabase(filePath);
  try {
    // A standalone restore file: no -wal/-shm sidecars.
    backup.exec('PRAGMA journal_mode = DELETE');
    const check = quickCheck(backup);
    if (check !== 'ok') throw new Error(`SQLite-controle mislukt (${check})`);
    const foreignKeyFailures = backup.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyFailures.length)
      throw new Error(`${foreignKeyFailures.length} verwijzing(en) naar ontbrekende gegevens`);
  } finally {
    backup.close();
  }
  parentPort?.postMessage({ ok: true });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
