// Populate a temporary database using the same schema as the Rust server.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { ExportRace } from './export-data.ts';

const schema = fs.readFileSync(new URL('../../native/src/schema.sql', import.meta.url), 'utf8');

export function writeExportDatabase(file: string, race: ExportRace): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(schema);
    db.exec('BEGIN');
    db.exec("PRAGMA user_version = 17; INSERT INTO settings VALUES ('schema_version', '17')");
    const insertRunner = db.prepare(
      `INSERT INTO runners (id, name, runner_number, registration_source, registration_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const runner of race.runners) {
      insertRunner.run(
        runner.id,
        runner.name,
        runner.runnerNumber,
        runner.registration ? 'import' : 'manual',
        runner.registration ? JSON.stringify(runner.registration) : null,
        race.raceStartedAt,
        race.raceStartedAt
      );
    }

    const insertLap = db.prepare(
      `INSERT INTO laps (id, runner_id, lap_number, started_at, finished_at, duration_ms, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const lap of race.laps) {
      insertLap.run(
        lap.id,
        lap.runnerId,
        lap.lapNumber,
        lap.startedAt,
        lap.finishedAt,
        lap.durationMs,
        lap.source,
        lap.createdAt
      );
    }
    db.prepare('INSERT INTO race_state (id, race_started_at, race_finished_at) VALUES (1, ?, ?)').run(
      race.raceStartedAt,
      race.raceFinishedAt
    );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}
