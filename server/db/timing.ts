import { v4 as uuidv4 } from 'uuid';
import { type RaceEvent, type RaceState } from '../../shared/schemas.js';
import { one, run, transaction } from './connection.js';
import { getLapCount, getRaceEventById } from './history.js';
import { getRunnerLabels } from './labels.js';
import {
  type QueueEntrySnapshot,
  getNextWaitingRunner,
  getQueueEntriesByRunnerIds,
  setQueueEntryStatus,
} from './queue.js';
import { clearActiveRunner, getRaceState, startActiveRunner } from './race-state.js';
import { getRunnerById } from './runner-queries.js';
import { cleanStatus, serializeHistoricalLabels } from './values.js';

type HandoffSnapshot = {
  raceState: RaceState;
  queueEntries: QueueEntrySnapshot[];
  lapIds: string[];
};

export function createBurgieGepaktEvent(nowMs = Date.now()): RaceEvent {
  const activeRunnerId = getRaceState().activeRunnerId;
  const activeRunner = activeRunnerId ? getRunnerById(activeRunnerId) : null;
  const id = uuidv4();
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

/**
 * The spacebar action: records the active runner's lap and starts the next
 * waiting runner. Stores what it replaced so the handoff can be undone.
 */
export function performHandoff(nowMs = Date.now()):
  | { ok: true; lapId: string | null; startedRunnerId: string | null }
  | { ok: false; error: 'empty_queue' } {
  const raceState = getRaceState();
  const activeRunnerId = raceState.activeRunnerId;
  const nextRunner = getNextWaitingRunner();

  if (!activeRunnerId && !nextRunner) {
    return { ok: false, error: 'empty_queue' };
  }

  const lapId = activeRunnerId ? uuidv4() : null;
  const affectedIds = [activeRunnerId, nextRunner?.id].filter((id): id is string => Boolean(id));
  const snapshot: HandoffSnapshot = {
    raceState,
    queueEntries: getQueueEntriesByRunnerIds(affectedIds),
    lapIds: lapId ? [lapId] : [],
  };

  transaction(() => {
    run(
      `INSERT INTO handoff_history (id, created_at, payload_json, undone)
       VALUES (?, ?, ?, 0)`,
      [uuidv4(), nowMs, JSON.stringify(snapshot)]
    );

    if (activeRunnerId) {
      const startedAt = raceState.activeStartedAt ?? nowMs;
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
          Math.max(0, nowMs - startedAt),
          nowMs,
          serializeHistoricalLabels(
            raceState.activeLabels.length ? raceState.activeLabels : getRunnerLabels(activeRunnerId)
          ),
        ]
      );
      setQueueEntryStatus(activeRunnerId, 'ran', nowMs);
    }

    if (nextRunner) {
      setQueueEntryStatus(nextRunner.id, 'running', nowMs);
      startActiveRunner(nextRunner.id, nowMs);
    } else {
      clearActiveRunner();
    }
  });

  return { ok: true, lapId, startedRunnerId: nextRunner?.id ?? null };
}

export function undoLastHandoff(): { ok: true; deletedLapIds: string[] } | { ok: false; error: 'nothing_to_undo' } {
  const row = one<{ id: string; payloadJson: string }>(
    `SELECT id, payload_json AS payloadJson
     FROM handoff_history
     WHERE undone = 0
     ORDER BY created_at DESC
     LIMIT 1`
  );
  if (!row) {
    return { ok: false, error: 'nothing_to_undo' };
  }

  const payload = JSON.parse(row.payloadJson) as Partial<HandoffSnapshot>;
  const deletedLapIds = payload.lapIds ?? [];
  const raceState: Partial<RaceState> = payload.raceState ?? {};
  transaction(() => {
    for (const lapId of deletedLapIds) {
      run('DELETE FROM laps WHERE id = ?', [lapId]);
    }

    for (const entry of payload.queueEntries ?? []) {
      run(
        `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(runner_id) DO UPDATE SET
           status = excluded.status,
           queue_index = excluded.queue_index,
           status_since = excluded.status_since,
           hidden_at = excluded.hidden_at`,
        [
          entry.runnerId,
          cleanStatus(entry.status),
          entry.queueIndex ?? null,
          entry.statusSince ?? null,
          entry.hiddenAt ?? null,
        ]
      );
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

export function finishRace(nowMs = Date.now()): void {
  const activeRunnerId = getRaceState().activeRunnerId;
  transaction(() => {
    if (activeRunnerId) setQueueEntryStatus(activeRunnerId, 'ran', nowMs);
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
