import {
  type QueueStatus,
  type TimingStatus,
  TIMING_RUNNER_MOVES,
  canHideRunner,
  canMoveRunner,
  queueIndexAfterMove,
} from '../../shared/lifecycle.js';
import { type Runner, type RunnerStatus } from '../../shared/schemas.js';
import { all, one, run, transaction } from './connection.js';
import { getRunnerById } from './runner-queries.js';
import { clusterNow } from '../clock.js';

import { queueStateSchema, type QueueState } from './handoff-snapshot.js';

export function hideRunnerInQueue(id: string, now = clusterNow()): Runner | null {
  const runner = one<{ status: RunnerStatus }>('SELECT status FROM runners WHERE id = ?', [id]);
  if (!runner) return null;
  if (!canHideRunner(runner.status)) throw new Error('Alleen gelopen lopers kunnen verborgen worden');
  run('UPDATE runners SET hidden_at = ? WHERE id = ?', [now, id]);
  return getRunnerById(id);
}

export function unhideRunnerInQueue(id: string): Runner | null {
  run('UPDATE runners SET hidden_at = NULL WHERE id = ?', [id]);
  return getRunnerById(id);
}

/**
 * An operator's move from Wachtrij or a runner's profile, checked against RUNNER_MOVES.
 * The same lane again is no move: a repeated click or a second laptop keeps the runner's
 * place. A runner moved to the queue joins at the back unless `queueIndex` says where.
 */
export function updateRunnerStatus({
  id,
  status,
  statusSince,
  queueIndex,
}: {
  id: string;
  status: QueueStatus;
  statusSince?: number | null;
  queueIndex?: number | null;
}): Runner | null {
  const current = one<{ status: RunnerStatus }>('SELECT status FROM runners WHERE id = ?', [id]);
  if (!current) return null;
  // A screen that has not seen the start yet would drop the live lap; only Timing takes a runner off the track.
  if (current.status === 'running') {
    throw new Error('Deze loper is net gestart op Timing. Wissel via het timingscherm.');
  }
  if (current.status === status) return getRunnerById(id);
  if (!canMoveRunner(current.status, status)) {
    throw new Error('Een loper die gelopen heeft, gaat terug naar opwarming of naar de wachtrij.');
  }
  run('UPDATE runners SET status = ?, queue_index = ?, status_since = ?, hidden_at = NULL WHERE id = ?', [
    status,
    status === 'waiting' && queueIndex != null ? queueIndex : queueIndexAfterMove(status, getMaxQueueIndex()),
    statusSince ?? clusterNow(),
    id,
  ]);
  return getRunnerById(id);
}

/** Timing's half of the runner moves: the next runner goes on the track, the one who ran comes off it. */
export function setRaceStatus(runnerId: string, status: TimingStatus, nowMs: number): void {
  const moved = run(
    'UPDATE runners SET status = ?, queue_index = NULL, status_since = ?, hidden_at = NULL WHERE id = ? AND status = ?',
    [status, nowMs, runnerId, TIMING_RUNNER_MOVES[status]]
  );
  if (moved.changes !== 1)
    throw new Error('Timingstatus is gewijzigd. Controleer de huidige loper en probeer opnieuw.');
}

export function updateWaitingOrder(idOrder: string[]): void {
  const uniqueIds = new Set(idOrder);
  const waitingIds = all<{ id: string }>("SELECT id FROM runners WHERE status = 'waiting'").map((row) => row.id);

  if (
    uniqueIds.size !== idOrder.length ||
    uniqueIds.size !== waitingIds.length ||
    waitingIds.some((id) => !uniqueIds.has(id))
  ) {
    throw new Error('De volledige wachtrijvolgorde is vereist');
  }

  transaction(() => {
    idOrder.forEach((id, index) => {
      run('UPDATE runners SET queue_index = ? WHERE id = ?', [index, id]);
    });
  });
}

export function getMaxQueueIndex(): number {
  return (
    one<{ maxIdx: number | null }>("SELECT MAX(queue_index) AS maxIdx FROM runners WHERE status = 'waiting'")?.maxIdx ??
    -1
  );
}

export function getQueueStates(ids: string[]): QueueState[] {
  return ids.flatMap((id) => {
    const state = one<QueueState>(
      `SELECT id AS runnerId, status, queue_index AS queueIndex, status_since AS statusSince, hidden_at AS hiddenAt
       FROM runners
       WHERE id = ?`,
      [id]
    );
    return state ? [queueStateSchema.parse(state)] : [];
  });
}

export function restoreQueueState(state: QueueState): void {
  // The queue may have been reordered since; make room so no two waiting runners share a place.
  if (state.status === 'waiting' && state.queueIndex != null) {
    run("UPDATE runners SET queue_index = queue_index + 1 WHERE status = 'waiting' AND queue_index >= ? AND id != ?", [
      state.queueIndex,
      state.runnerId,
    ]);
  }
  run('UPDATE runners SET status = ?, queue_index = ?, status_since = ?, hidden_at = ? WHERE id = ?', [
    state.status,
    state.queueIndex ?? null,
    state.statusSince ?? null,
    state.hiddenAt ?? null,
    state.runnerId,
  ]);
}

export function getNextWaitingRunner(): { id: string; name: string } | null {
  return one<{ id: string; name: string }>(
    `SELECT id, name
     FROM runners
     WHERE status = 'waiting'
     ORDER BY queue_index ASC, status_since ASC
     LIMIT 1`
  );
}
