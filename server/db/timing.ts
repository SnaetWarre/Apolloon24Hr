import { randomUUID } from 'node:crypto';
import { type UndoKind, canUndo, timingPress } from '../../shared/lifecycle.js';
import { type RaceEvent, type RaceState } from '../../shared/schemas.js';
import { one, run, transaction } from './connection.js';
import { getLapCount, getRaceEventById, getRecentRaceEvents } from './history.js';
import { getRunnerLabels } from './labels.js';
import { type QueueState, getNextWaitingRunner, getQueueStates, restoreQueueState, setRaceStatus } from './queue.js';
import { getRaceState, moveRace, writeRaceState } from './race-state.js';
import { getRunnerById } from './runner-queries.js';
import { serializeHistoricalLabels } from './values.js';
import { clusterNow } from '../clock.js';

/** An entry on the undo stack (`handoff_history`): what the step replaced, so undo can put it back. */
type HandoffSnapshot = {
  /** Entries stored before 2026-11 have none; see topEntry. */
  kind?: UndoKind;
  raceState: RaceState;
  /** Stored as `queueEntries` since before the queue lived on `runners`. */
  queueEntries: QueueState[];
  lapIds: string[];
};

/** A press this close to the last Burgie is the same Burgie: a double click, or two laptops at once. */
const BURGIE_REPEAT_MS = 5_000;

export function createBurgieGepaktEvent(nowMs = clusterNow()): RaceEvent {
  const [newest] = getRecentRaceEvents(1);
  if (newest?.type === 'burgie_gepakt' && Math.abs(nowMs - newest.occurredAt) < BURGIE_REPEAT_MS) return newest;
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
 * waiting runner. Stores what it replaced so the handoff can be undone. After
 * Race beëindigen it only starts the next runner when the press says it means to
 * resume the race (`resume`).
 *
 * `nowMs` is the moment of the press. `measuredDurationMs`, when the timing
 * screen measured the lap between its own two presses, is used as the lap
 * time: it comes from one monotonic clock and ignores clock corrections.
 */
export function performHandoff(
  nowMs = clusterNow(),
  measuredDurationMs?: number,
  { resume = false } = {}
):
  | { ok: true; lapId: string | null; startedRunnerId: string | null }
  | { ok: false; error: 'empty_queue' | 'finished' } {
  const raceState = getRaceState();
  const activeRunnerId = raceState.activeRunnerId;
  const nextRunner = getNextWaitingRunner();
  const move = timingPress(raceState);

  if (move === 'resume' && !resume) return { ok: false, error: 'finished' };
  if (!activeRunnerId && !nextRunner) {
    return { ok: false, error: 'empty_queue' };
  }

  const lapId = activeRunnerId ? randomUUID() : null;
  const affectedIds = [activeRunnerId, nextRunner?.id].filter((id): id is string => Boolean(id));
  const snapshot: HandoffSnapshot = {
    kind: 'handoff',
    raceState,
    queueEntries: getQueueStates(affectedIds),
    lapIds: lapId ? [lapId] : [],
  };

  transaction(() => {
    moveRace(move, nowMs, nextRunner?.id ?? null);
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
            raceState.activeLabels.length ? raceState.activeLabels : getRunnerLabels(activeRunnerId)
          ),
        ]
      );
      setRaceStatus(activeRunnerId, 'ran', nowMs);
    }

    if (nextRunner) setRaceStatus(nextRunner.id, 'running', nowMs);
  });

  return { ok: true, lapId, startedRunnerId: nextRunner?.id ?? null };
}

/**
 * The newest entry that is not undone, and what it takes back. Entries stored before the
 * kind was saved are a finish only when they are the step that finished the current race:
 * the same moment as its end.
 */
function topEntry(): { id: string; payloadJson: string; kind: UndoKind } | null {
  const row = one<{ id: string; payloadJson: string; kind: UndoKind | null; isFinish: number }>(
    `SELECT id, payload_json AS payloadJson, json_extract(payload_json, '$.kind') AS kind,
       created_at = (SELECT race_finished_at FROM race_state WHERE id = 1) AS isFinish
     FROM handoff_history
     WHERE undone = 0
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`
  );
  return row
    ? { id: row.id, payloadJson: row.payloadJson, kind: row.kind ?? (row.isFinish ? 'finish' : 'handoff') }
    : null;
}

/** What the next undo takes back, or null when there is nothing to undo. */
export function nextUndo(): UndoKind | null {
  return topEntry()?.kind ?? null;
}

/** The laps the next undo removes, including halves a split added. */
export function lapsToUndo(): string[] {
  const row = topEntry();
  return row ? ((JSON.parse(row.payloadJson) as Partial<HandoffSnapshot>).lapIds ?? []) : [];
}

/** Puts back what the newest entry replaced, after checking the race allows it (canUndo). */
export function undoLastHandoff():
  | { ok: true; deletedLapIds: string[] }
  | { ok: false; error: 'nothing_to_undo' | 'finished' } {
  const row = topEntry();
  if (!row) return { ok: false, error: 'nothing_to_undo' };
  if (!canUndo(getRaceState(), row.kind)) return { ok: false, error: 'finished' };
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

    writeRaceState({
      activeRunnerId: raceState.activeRunnerId ?? null,
      activeStartedAt: raceState.activeStartedAt ?? null,
      // Before #152 a race could be finished during setup, then resumed. Its saved
      // undo snapshot has a finish but no start, just like an old restored backup.
      raceStartedAt: raceState.raceStartedAt ?? (raceState.activeRunnerId ? null : raceState.raceFinishedAt) ?? null,
      raceFinishedAt: raceState.raceFinishedAt ?? null,
      activeLabels: raceState.activeLabels ?? [],
    });
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
    kind: 'finish',
    raceState,
    queueEntries: getQueueStates(activeRunnerId ? [activeRunnerId] : []),
    lapIds: [],
  };
  transaction(() => {
    moveRace('finish', nowMs);
    run(
      `INSERT INTO handoff_history (id, created_at, payload_json, undone)
       VALUES (?, ?, ?, 0)`,
      [randomUUID(), nowMs, JSON.stringify(snapshot)]
    );
    if (activeRunnerId) setRaceStatus(activeRunnerId, 'ran', nowMs);
  });
}
