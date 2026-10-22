import { type RaceState } from '../../shared/schemas.js';
import { one, run } from './connection.js';
import { getRunnerLabels } from './labels.js';
import { parseLabelsJson } from './values.js';

export function getRaceState(): RaceState {
  const row = one<Omit<RaceState, 'id' | 'activeLabels'> & { activeLabelsJson: string | null }>(
    `SELECT
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

/**
 * A race with fewer laps than this is a test: a start or a few laps to try
 * the timing screen. At 70 to 85 s a lap, the real race passes it in about
 * 13 minutes.
 */
export const RACE_COUNTS_FROM_LAPS = 10;

/**
 * Whether the race started here, and whether it still runs: started and not
 * finished. It counts as started from RACE_COUNTS_FROM_LAPS laps on, so a test
 * never decides which laptop keeps its data on Koppelen, and never stops two
 * laptops from merging their runners.
 */
export function raceProgress(): { raceStarted: boolean; raceRunning: boolean } {
  const row = one<{ laps: number; finished: number }>(
    `SELECT (SELECT COUNT(*) FROM (SELECT 1 FROM laps LIMIT ?)) AS laps,
       (SELECT race_finished_at FROM race_state WHERE id = 1) IS NOT NULL AS finished`,
    [RACE_COUNTS_FROM_LAPS]
  );
  const raceStarted = (row?.laps ?? 0) >= RACE_COUNTS_FROM_LAPS;
  return { raceStarted, raceRunning: raceStarted && !row?.finished };
}

/** Starts the runner's live lap, starting (or reopening) the race if needed. The lap keeps the labels of this moment. */
export function startActiveRunner(runnerId: string, nowMs: number): void {
  run(
    `UPDATE race_state
     SET active_runner_id = ?,
         active_started_at = ?,
         race_started_at = COALESCE(race_started_at, ?),
         race_finished_at = NULL,
         active_labels_json = ?
     WHERE id = 1`,
    [runnerId, nowMs, nowMs, JSON.stringify(getRunnerLabels(runnerId))]
  );
}

/** Clears the live lap; with a runner id, only when that runner is the active one. */
export function clearActiveRunner(runnerId?: string): void {
  const sql = `UPDATE race_state
     SET active_runner_id = NULL,
         active_started_at = NULL,
         active_labels_json = NULL
     WHERE id = 1`;
  if (runnerId) run(`${sql} AND active_runner_id = ?`, [runnerId]);
  else run(sql);
}

/**
 * Takes the race back to before the start, for after a test run: laps, handoffs,
 * race events and the queue go; runners, labels and settings stay. Everyone is
 * registered again, so they are checked in anew for the real race. With
 * `runners`, the runners go too, for a laptop that starts over from an empty list.
 */
export function clearRace(nowMs: number, { runners = false } = {}): { laps: number; runners: number } {
  const laps = one<{ count: number }>('SELECT COUNT(*) AS count FROM laps')?.count ?? 0;
  const runnerCount = runners ? (one<{ count: number }>('SELECT COUNT(*) AS count FROM runners')?.count ?? 0) : 0;
  for (const table of ['laps', 'handoff_history', 'race_events']) run(`DELETE FROM ${table}`);
  run(
    `UPDATE race_state
     SET active_runner_id = NULL, active_started_at = NULL, race_started_at = NULL,
         race_finished_at = NULL, active_labels_json = NULL
     WHERE id = 1`
  );
  run(
    `UPDATE runners SET status = 'registered', queue_index = NULL, status_since = ?, hidden_at = NULL
     WHERE status <> 'registered' OR queue_index IS NOT NULL OR hidden_at IS NOT NULL`,
    [nowMs]
  );
  if (runners) for (const table of ['runner_labels', 'runners']) run(`DELETE FROM ${table}`);
  return { laps, runners: runnerCount };
}
