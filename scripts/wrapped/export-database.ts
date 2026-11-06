// Writes the runners and laps of an exported workbook into a throwaway Apolloon database,
// so the built app can draw the same Wrapped pages it drew after the race. Kept apart from
// export-data.ts because the server modules read DATA_PATH when they are first imported.
import { DB_FILE, closeDb, run } from '../../server/db/connection.ts';
import { initDb, insertRunner } from '../../server/db.ts';
import type { ExportRace } from './export-data.ts';

/** Creates the database under the current DATA_PATH and returns its app.db. */
export async function writeExportDatabase(race: ExportRace): Promise<string> {
  await initDb();
  for (const runner of race.runners) {
    insertRunner({
      id: runner.id,
      name: runner.name,
      runnerNumber: runner.runnerNumber ?? undefined,
      registrationSource: runner.registration ? 'import' : 'manual',
      registration: runner.registration,
    });
  }
  for (const lap of race.laps) {
    run(
      `INSERT INTO laps (id, runner_id, lap_number, started_at, finished_at, duration_ms, source, created_at, labels_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lap.id,
        lap.runnerId,
        lap.lapNumber,
        lap.startedAt,
        lap.finishedAt,
        lap.durationMs,
        lap.source,
        lap.createdAt,
        '[]',
      ]
    );
  }
  // The export has no race start or finish of its own, so the first lap starts the race and
  // the last one ends it. Nothing is on the track: every lap already finished.
  run(
    `UPDATE race_state
     SET active_runner_id = NULL, active_started_at = NULL, race_started_at = ?, race_finished_at = ?
     WHERE id = 1`,
    [race.raceStartedAt, race.raceFinishedAt]
  );
  closeDb();
  return DB_FILE;
}
