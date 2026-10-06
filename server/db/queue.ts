import { type Runner, type RunnerStatus } from '../../shared/schemas.js';
import { all, one, run, transaction } from './connection.js';
import { clearActiveRunner, getRaceState, startActiveRunner } from './race-state.js';
import { getRunnerById } from './runner-queries.js';
import { clusterNow } from '../clock.js';

/** A runner's place in the flow, as stored with a handoff so it can be undone. */
export type QueueState = {
  runnerId: string;
  status: RunnerStatus;
  queueIndex: number | null;
  statusSince: number | null;
  hiddenAt: number | null;
};

export function hideRunnerInQueue(id: string, now = clusterNow()): Runner | null {
  run('UPDATE runners SET hidden_at = ? WHERE id = ?', [now, id]);
  return getRunnerById(id);
}

export function unhideRunnerInQueue(id: string): Runner | null {
  run('UPDATE runners SET hidden_at = NULL WHERE id = ?', [id]);
  return getRunnerById(id);
}

export function updateRunnerStatus({
  id,
  status,
  statusSince,
  queueIndex,
}: {
  id: string;
  status: RunnerStatus;
  statusSince?: number | null;
  queueIndex?: number | null;
}): Runner | null {
  if (!one<{ id: string }>('SELECT id FROM runners WHERE id = ?', [id])) return null;
  if (status === 'running') {
    const activeRunnerId = getRaceState().activeRunnerId;
    if (activeRunnerId && activeRunnerId !== id) {
      throw new Error('Er loopt al een loper');
    }
  }
  const now = statusSince ?? clusterNow();
  const nextQueueIndex = status !== 'waiting' ? null : (queueIndex ?? getMaxQueueIndex() + 1);

  transaction(() => {
    run('UPDATE runners SET status = ?, queue_index = ?, status_since = ?, hidden_at = NULL WHERE id = ?', [
      status,
      nextQueueIndex,
      now,
      id,
    ]);
    if (status === 'running') startActiveRunner(id, now);
    else clearActiveRunner(id);
  });

  return getRunnerById(id);
}

/** Moves a runner out of the waiting order into `running` or `ran`. */
export function setRaceStatus(runnerId: string, status: 'running' | 'ran', nowMs: number): void {
  run('UPDATE runners SET status = ?, queue_index = NULL, status_since = ?, hidden_at = NULL WHERE id = ?', [
    status,
    nowMs,
    runnerId,
  ]);
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
    return state ? [state] : [];
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
