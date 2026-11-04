import {
  type RaceMove,
  RACE_COUNTS_FROM_LAPS,
  canMoveRace,
  countedRaceProgress,
  raceMoveRefusal,
  raceStateProblem,
} from '../../shared/lifecycle.js';
import { type RaceState } from '../../shared/schemas.js';
import { one, run } from './connection.js';
import { getRunnerLabels } from './labels.js';
import { parseLabelsJson } from './values.js';

export { RACE_COUNTS_FROM_LAPS };

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

/** The race as linking laptops count it: see countedRaceProgress. */
export function raceProgress(): { raceStarted: boolean; raceRunning: boolean } {
  const laps = one<{ laps: number }>('SELECT COUNT(*) AS laps FROM (SELECT 1 FROM laps LIMIT ?)', [
    RACE_COUNTS_FROM_LAPS,
  ]);
  return countedRaceProgress(laps?.laps ?? 0, getRaceState());
}

type RaceFields = Omit<RaceState, 'id'>;

/** The only write to `race_state` (besides a restore): refuses columns that are no phase of the race. */
export function writeRaceState(next: RaceFields): void {
  const problem = raceStateProblem(next);
  if (problem) throw new Error(`Ongeldige racetoestand: ${problem}`);
  run(
    `UPDATE race_state
     SET active_runner_id = ?,
         active_started_at = ?,
         race_started_at = ?,
         race_finished_at = ?,
         active_labels_json = ?
     WHERE id = 1`,
    [
      next.activeRunnerId,
      next.activeStartedAt,
      next.raceStartedAt,
      next.raceFinishedAt,
      next.activeRunnerId === null ? null : JSON.stringify(next.activeLabels),
    ]
  );
}

/**
 * Makes a Timing press, after checking the race allows it (RACE_MOVES). `start`, `resume`
 * and `handoff` put `nextRunnerId` on the track at `nowMs`, with the labels of this moment
 * for the lap; a handoff without a next runner leaves the track empty.
 */
export function moveRace(move: RaceMove, nowMs: number, nextRunnerId: string | null = null): void {
  const race = getRaceState();
  if (!canMoveRace(race, move)) throw new Error(raceMoveRefusal(race, move));
  if (move === 'finish') {
    writeRaceState({ ...race, activeRunnerId: null, activeStartedAt: null, activeLabels: [], raceFinishedAt: nowMs });
  } else if (nextRunnerId) {
    writeRaceState({
      activeRunnerId: nextRunnerId,
      activeStartedAt: nowMs,
      raceStartedAt: race.raceStartedAt ?? nowMs,
      raceFinishedAt: null,
      activeLabels: getRunnerLabels(nextRunnerId),
    });
  } else if (move === 'handoff') {
    writeRaceState({ ...race, activeRunnerId: null, activeStartedAt: null, activeLabels: [] });
  } else {
    throw new Error('Niemand staat klaar in de wachtrij');
  }
}

/** Takes a deleted runner off the track; the race goes on with nobody running. */
export function clearActiveRunner(runnerId: string): void {
  const race = getRaceState();
  if (race.activeRunnerId === runnerId) {
    writeRaceState({ ...race, activeRunnerId: null, activeStartedAt: null, activeLabels: [] });
  }
}

/** Back to before the start: for Race wissen and the demo race. */
export function resetRaceState(): void {
  writeRaceState({
    activeRunnerId: null,
    activeStartedAt: null,
    raceStartedAt: null,
    raceFinishedAt: null,
    activeLabels: [],
  });
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
  resetRaceState();
  run(
    `UPDATE runners SET status = 'registered', queue_index = NULL, status_since = ?, hidden_at = NULL
     WHERE status <> 'registered' OR queue_index IS NOT NULL OR hidden_at IS NOT NULL`,
    [nowMs]
  );
  if (runners) for (const table of ['runner_labels', 'runners']) run(`DELETE FROM ${table}`);
  return { laps, runners: runnerCount };
}
