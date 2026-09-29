import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';

// Runs off the main thread so integrity checks never delay a timing request.
const { filePath } = workerData as { filePath: string };

try {
  const backup = new Database(filePath, { fileMustExist: true });
  try {
    // A standalone restore file: no -wal/-shm sidecars.
    backup.pragma('journal_mode = DELETE');
    const quickCheck = backup.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') throw new Error(`SQLite-controle mislukt (${String(quickCheck)})`);
    const foreignKeyFailures = backup.pragma('foreign_key_check') as unknown[];
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
