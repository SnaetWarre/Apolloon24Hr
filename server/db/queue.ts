import { type Runner, type RunnerStatus } from '../../shared/schemas.js';
import { cleanInt, cleanStatus } from './values.js';
import { run, one, transaction, all } from './connection.js';
import { getRunnerById } from './runner-queries.js';
import { getRaceState } from './history.js';
import { getRunnerLabels } from './labels.js';

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
 * Poort rond statuswijzigingen die de live race raken. Telsysteem 1 werkt de
 * hele dag op een andere laptop dan de timing; zonder deze poort kan één klik
 * daar de live ronde wissen of een gefinishte race stilletjes heropenen.
 *
 * Puur (geen DB-toegang) zodat de regels unit-testbaar zijn; de router vult de
 * live waarden in en zet een melding om in een conflict-fout.
 *
 * Retourneert null als de wijziging mag, anders de Nederlandse foutmelding.
 */
export function runnerStatusChangeError(input: {
  runnerId: string;
  status: RunnerStatus;
  activeRunnerId: string | null;
  raceFinishedAt: number | null;
  controllerHostId: string | null;
  localHostId: string;
}): string | null {
  const controlledElsewhere =
    Boolean(input.controllerHostId) && input.controllerHostId !== input.localHostId;
  const touchesLiveLap =
    input.activeRunnerId !== null &&
    input.runnerId === input.activeRunnerId &&
    input.status !== 'running';
  if (touchesLiveLap && controlledElsewhere) {
    return 'Deze loper loopt nu live. Alleen de timinglaptop kan dit aanpassen.';
  }
  const manualStart =
    input.status === 'running' &&
    (input.activeRunnerId === null || input.activeRunnerId !== input.runnerId);
  if (manualStart && input.raceFinishedAt !== null && controlledElsewhere) {
    return 'De race is gefinisht. Hervatten kan alleen op de timinglaptop.';
  }
  if (manualStart && input.raceFinishedAt === null && controlledElsewhere) {
    return 'Alleen de timinglaptop kan een loper handmatig laten starten.';
  }
  return null;
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
    nextStatus === 'waiting'
      ? queueIndex !== undefined && queueIndex !== null
        ? cleanInt(queueIndex)
        : getMaxQueueIndex() + 1
      : null;

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

    if (nextStatus === 'running') {
      run(
        `UPDATE race_state
         SET active_runner_id = ?,
             active_started_at = ?,
             race_started_at = COALESCE(race_started_at, ?),
             race_finished_at = NULL,
             active_labels_json = ?
         WHERE id = 1`,
        [id, now, now, JSON.stringify(getRunnerLabels(id))]
      );
    } else {
      run(
        `UPDATE race_state
         SET active_runner_id = NULL,
             active_started_at = NULL,
             active_labels_json = NULL
         WHERE id = 1 AND active_runner_id = ?`,
        [id]
      );
    }
  });

  return getRunnerById(id);
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
  const row = one<{ maxIdx: number | null }>("SELECT MAX(queue_index) AS maxIdx FROM queue_entries WHERE status = 'waiting'");
  return typeof row?.maxIdx === 'number' ? row.maxIdx : -1;
}

export function getQueueEntriesByRunnerIds(ids: string[]): QueueEntrySnapshot[] {
  if (!ids.length) return [];
  return ids
    .map((id) =>
      one<QueueEntrySnapshot>(
        `SELECT
           runner_id AS runnerId,
           status,
           queue_index AS queueIndex,
           status_since AS statusSince,
           hidden_at AS hiddenAt
         FROM queue_entries
         WHERE runner_id = ?`,
        [id]
      )
    )
    .filter((entry): entry is QueueEntrySnapshot => Boolean(entry));
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

export type QueueEntrySnapshot = {
  runnerId: string;
  status: RunnerStatus;
  queueIndex: number | null;
  statusSince: number | null;
  hiddenAt: number | null;
};
