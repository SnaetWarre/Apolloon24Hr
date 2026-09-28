import { type Runner, type RunnerStatus } from '../../shared/schemas.js';
import { all, one, run, transaction } from './connection.js';
import { clearActiveRunner, getRaceState, startActiveRunner } from './race-state.js';
import { getRunnerById } from './runner-queries.js';
import { cleanInt, cleanStatus } from './values.js';

export type QueueEntrySnapshot = {
  runnerId: string;
  status: RunnerStatus;
  queueIndex: number | null;
  statusSince: number | null;
  hiddenAt: number | null;
};

export function hideRunnerInQueue(id: string, hiddenAt = Date.now()): Runner | null {
  const now = cleanInt(hiddenAt) ?? Date.now();
  run(
    `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
     VALUES (?, 'registered', NULL, ?, ?)
     ON CONFLICT(runner_id) DO UPDATE SET
       hidden_at = excluded.hidden_at`,
    [id, now, now]
  );
  return getRunnerById(id);
}

export function unhideRunnerInQueue(id: string): Runner | null {
  run(
    `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
     VALUES (?, 'registered', NULL, ?, NULL)
     ON CONFLICT(runner_id) DO UPDATE SET
       hidden_at = NULL`,
    [id, Date.now()]
  );
  return getRunnerById(id);
}

/**
 * Guards status changes that touch the live race. The queue desk works on a
 * different laptop than timing all day; without this, one click there could
 * wipe the live lap or silently reopen a finished race.
 *
 * Pure so the rules are unit-testable. Returns null when the change is
 * allowed, otherwise the (Dutch) message shown to the operator.
 */
export function runnerStatusChangeError(input: {
  runnerId: string;
  status: RunnerStatus;
  activeRunnerId: string | null;
  raceFinishedAt: number | null;
  controllerHostId: string | null;
  localHostId: string;
}): string | null {
  const controlledElsewhere = Boolean(input.controllerHostId) && input.controllerHostId !== input.localHostId;
  if (!controlledElsewhere) return null;
  const touchesLiveLap =
    input.activeRunnerId !== null && input.runnerId === input.activeRunnerId && input.status !== 'running';
  if (touchesLiveLap) {
    return 'Deze loper loopt nu live. Alleen de timinglaptop kan dit aanpassen.';
  }
  const manualStart = input.status === 'running' && input.activeRunnerId !== input.runnerId;
  if (!manualStart) return null;
  return input.raceFinishedAt !== null
    ? 'De race is gefinisht. Hervatten kan alleen op de timinglaptop.'
    : 'Alleen de timinglaptop kan een loper handmatig laten starten.';
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
  const nextStatus = cleanStatus(status);
  if (nextStatus === 'running') {
    const activeRunnerId = getRaceState().activeRunnerId;
    if (activeRunnerId && activeRunnerId !== id) {
      throw new Error('Er loopt al een loper');
    }
  }
  const now = cleanInt(statusSince) ?? Date.now();
  const nextQueueIndex =
    nextStatus !== 'waiting' ? null : queueIndex != null ? cleanInt(queueIndex) : getMaxQueueIndex() + 1;

  transaction(() => {
    run(
      `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(runner_id) DO UPDATE SET
         status = excluded.status,
         queue_index = excluded.queue_index,
         status_since = excluded.status_since,
         hidden_at = NULL`,
      [id, nextStatus, nextQueueIndex, now]
    );
    if (nextStatus === 'running') startActiveRunner(id, now);
    else clearActiveRunner(id);
  });

  return getRunnerById(id);
}

/** Moves a runner out of the waiting order into `running` or `ran`. */
export function setQueueEntryStatus(runnerId: string, status: 'running' | 'ran', nowMs: number): void {
  run(
    `UPDATE queue_entries
     SET status = ?, queue_index = NULL, status_since = ?, hidden_at = NULL
     WHERE runner_id = ?`,
    [status, nowMs, runnerId]
  );
}

export function updateWaitingOrder(idOrder: string[]): void {
  const uniqueIds = new Set(idOrder);
  const waitingIds = all<{ id: string }>(
    `SELECT runner_id AS id
     FROM queue_entries
     WHERE status = 'waiting'`
  ).map((entry) => entry.id);

  if (
    uniqueIds.size !== idOrder.length ||
    uniqueIds.size !== waitingIds.length ||
    waitingIds.some((id) => !uniqueIds.has(id))
  ) {
    throw new Error('De volledige wachtrijvolgorde is vereist');
  }

  const now = Date.now();
  transaction(() => {
    idOrder.forEach((id, idx) => {
      run(
        `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
         VALUES (?, 'waiting', ?, ?, NULL)
         ON CONFLICT(runner_id) DO UPDATE SET
           status = 'waiting',
           queue_index = excluded.queue_index,
           status_since = COALESCE(queue_entries.status_since, excluded.status_since),
           hidden_at = NULL`,
        [id, idx, now]
      );
    });
  });
}

export function getMaxQueueIndex(): number {
  return (
    one<{ maxIdx: number | null }>("SELECT MAX(queue_index) AS maxIdx FROM queue_entries WHERE status = 'waiting'")
      ?.maxIdx ?? -1
  );
}

export function getQueueEntriesByRunnerIds(ids: string[]): QueueEntrySnapshot[] {
  return ids.flatMap((id) => {
    const entry = one<QueueEntrySnapshot>(
      `SELECT
         runner_id AS runnerId,
         status,
         queue_index AS queueIndex,
         status_since AS statusSince,
         hidden_at AS hiddenAt
       FROM queue_entries
       WHERE runner_id = ?`,
      [id]
    );
    return entry ? [entry] : [];
  });
}

export function getNextWaitingRunner(): { id: string; name: string } | null {
  return one<{ id: string; name: string }>(
    `SELECT r.id, r.name
     FROM runners r
     JOIN queue_entries q ON q.runner_id = r.id
     WHERE q.status = 'waiting'
     ORDER BY q.queue_index ASC, q.status_since ASC
     LIMIT 1`
  );
}
