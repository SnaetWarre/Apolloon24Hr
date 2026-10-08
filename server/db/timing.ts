import { randomUUID } from 'node:crypto';
import { type RaceEvent, type RaceState } from '../../shared/schemas.js';
import { one, run, transaction } from './connection.js';
import { getLapCount, getRaceEventById } from './history.js';
import { getRunnerLabels } from './labels.js';
import { type QueueState, getNextWaitingRunner, getQueueStates, restoreQueueState, setRaceStatus } from './queue.js';
import { clearActiveRunner, getRaceState, startActiveRunner } from './race-state.js';
import { getRunnerById } from './runner-queries.js';
import { serializeHistoricalLabels } from './values.js';
import { clusterNow } from '../clock.js';

type HandoffSnapshot = {
  raceState: RaceState;
  /** Stored as `queueEntries` since before the queue lived on `runners`. */
  queueEntries: QueueState[];
  lapIds: string[];
};

export function createBurgieGepaktEvent(nowMs = clusterNow()): RaceEvent {
  const activeRunnerId = getRaceState().activeRunnerId;
  const activeRunner = activeRunnerId ? getRunnerById(activeRunnerId) : null;
  const id = randomUUID();
  run(
    `INSERT INTO race_events (
      id,
      type,
      message,
      occurred_at,
      runner_id,
      runner_number,
      runner_name,
      created_at
    ) VALUES (?, 'burgie_gepakt', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      'Burgie gepakt',
      nowMs,
      activeRunner?.id ?? null,
      activeRunner?.runnerNumber ?? null,
      activeRunner?.name ?? null,
      nowMs,
    ]
  );
  const event = getRaceEventById(id);
  if (!event) throw new Error('race event insert failed');
  return event;
}

/** How far a duration measured by the timing screen may differ from the clock difference before it is distrusted. */
const MAX_MEASUREMENT_DIFFERENCE_MS = 250;

/**
 * The spacebar action: records the active runner's lap and starts the next
 * waiting runner. Stores what it replaced so the handoff can be undone.
 *
 * `nowMs` is the moment of the press. `measuredDurationMs`, when the timing
 * screen measured the lap between its own two presses, is used as the lap
 * time: it comes from one monotonic clock and ignores clock corrections.
 */
export function performHandoff(
  nowMs = clusterNow(),
  measuredDurationMs?: number
): { ok: true; lapId: string | null; startedRunnerId: string | null } | { ok: false; error: 'empty_queue' } {
  const raceState = getRaceState();
  const activeRunnerId = raceState.activeRunnerId;
  const nextRunner = getNextWaitingRunner();

  if (!activeRunnerId && !nextRunner) {
    return { ok: false, error: 'empty_queue' };
  }

  const lapId = activeRunnerId ? randomUUID() : null;
  const affectedIds = [activeRunnerId, nextRunner?.id].filter((id): id is string => Boolean(id));
  const snapshot: HandoffSnapshot = {
    raceState,
    queueEntries: getQueueStates(affectedIds),
    lapIds: lapId ? [lapId] : [],
  };

  transaction(() => {
    run(
      `INSERT INTO handoff_history (id, created_at, payload_json, undone)
       VALUES (?, ?, ?, 0)`,
      [randomUUID(), nowMs, JSON.stringify(snapshot)]
    );

    if (activeRunnerId) {
      const startedAt = raceState.activeStartedAt ?? nowMs;
      const clockDurationMs = Math.max(0, nowMs - startedAt);
      const durationMs =
        measuredDurationMs !== undefined &&
        Math.abs(measuredDurationMs - clockDurationMs) <= MAX_MEASUREMENT_DIFFERENCE_MS
          ? measuredDurationMs
          : clockDurationMs;
      run(
        `INSERT INTO laps (
          id,
          runner_id,
          lap_number,
          started_at,
          finished_at,
          duration_ms,
          source,
          created_at,
          labels_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'spacebar', ?, ?)`,
        [
          lapId,
          activeRunnerId,
          getLapCount(activeRunnerId) + 1,
          startedAt,
          nowMs,
          durationMs,
          nowMs,
          serializeHistoricalLabels(
            raceState.activeLabels.length ? raceState.activeLabels : getRunnerLabels(activeRunnerId, startedAt)
          ),
        ]
      );
      setRaceStatus(activeRunnerId, 'ran', nowMs);
    }

    if (nextRunner) {
      setRaceStatus(nextRunner.id, 'running', nowMs);
      startActiveRunner(nextRunner.id, nowMs);
    } else {
      clearActiveRunner();
    }
  });

  return { ok: true, lapId, startedRunnerId: nextRunner?.id ?? null };
}

function lastHandoff() {
  return one<{ id: string; createdAt: number; payloadJson: string }>(
    `SELECT id, created_at AS createdAt, payload_json AS payloadJson
     FROM handoff_history
     WHERE undone = 0
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`
  );
}

/** The laps the next undo removes, including halves a split added. */
export function lapsToUndo(): string[] {
  const row = lastHandoff();
  return row ? ((JSON.parse(row.payloadJson) as Partial<HandoffSnapshot>).lapIds ?? []) : [];
}

export function undoLastHandoff(): { ok: true; deletedLapIds: string[] } | { ok: false; error: 'nothing_to_undo' } {
  const row = lastHandoff();
  if (!row) {
    return { ok: false, error: 'nothing_to_undo' };
  }

  const payload = JSON.parse(row.payloadJson) as Partial<HandoffSnapshot>;
  const deletedLapIds = payload.lapIds ?? [];
  const snapshotState: Partial<RaceState> = payload.raceState ?? {};
  // Beheer › Lopers may have deleted that runner since; then nobody goes back on the track.
  const raceState =
    snapshotState.activeRunnerId && !getRunnerById(snapshotState.activeRunnerId)
      ? { ...snapshotState, activeRunnerId: null, activeStartedAt: null, activeLabels: [] }
      : snapshotState;
  transaction(() => {
    for (const lapId of deletedLapIds) {
      run('DELETE FROM laps WHERE id = ?', [lapId]);
    }

    for (const state of payload.queueEntries ?? []) {
      if (getRunnerById(state.runnerId)) restoreQueueState(state);
    }

    run(
      `UPDATE race_state
       SET active_runner_id = ?,
           active_started_at = ?,
           race_started_at = ?,
           race_finished_at = ?,
           active_labels_json = ?
       WHERE id = 1`,
      [
        raceState.activeRunnerId ?? null,
        raceState.activeStartedAt ?? null,
        raceState.raceStartedAt ?? null,
        raceState.raceFinishedAt ?? null,
        JSON.stringify(raceState.activeLabels ?? []),
      ]
    );
    run('UPDATE handoff_history SET undone = 1 WHERE id = ?', [row.id]);
  });

  return { ok: true, deletedLapIds };
}

/**
 * Ends the race without recording a lap for the active runner. Stores what it
 * replaced, so the next undo reopens the race with that runner still running.
 */
export function finishRace(nowMs = clusterNow()): void {
  const raceState = getRaceState();
  const activeRunnerId = raceState.activeRunnerId;
  const snapshot: HandoffSnapshot = {
    raceState,
    queueEntries: getQueueStates(activeRunnerId ? [activeRunnerId] : []),
    lapIds: [],
  };
  transaction(() => {
    run(
      `INSERT INTO handoff_history (id, created_at, payload_json, undone)
       VALUES (?, ?, ?, 0)`,
      [randomUUID(), nowMs, JSON.stringify(snapshot)]
    );
    if (activeRunnerId) setRaceStatus(activeRunnerId, 'ran', nowMs);
    run(
      `UPDATE race_state
       SET active_runner_id = NULL,
           active_started_at = NULL,
           active_labels_json = NULL,
           race_finished_at = ?
       WHERE id = 1`,
      [nowMs]
    );
  });
}

/** Whether the last undo step is this finish. Races finished before finishing stored one have none. */
export function canUndoFinish(): boolean {
  const { raceFinishedAt } = getRaceState();
  const row = lastHandoff();
  return raceFinishedAt !== null && row?.createdAt === raceFinishedAt;
}
