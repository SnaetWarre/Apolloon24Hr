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

/** True once the race started or a lap was counted here; a laptop that holds it keeps its data on Koppelen. */
export function hasRaceStarted(): boolean {
  return Boolean(
    one<{ started: number }>(
      `SELECT (SELECT race_started_at FROM race_state WHERE id = 1) IS NOT NULL
         OR EXISTS (SELECT 1 FROM laps) AS started`
    )?.started
  );
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
    [runnerId, nowMs, nowMs, JSON.stringify(getRunnerLabels(runnerId, nowMs))]
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
