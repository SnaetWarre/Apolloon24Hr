import { type Runner, type Label } from '../../shared/schemas.js';
import { cleanRegistrationSource, cleanStatus } from './values.js';
import { getRunnerLabelsMap, getRunnerLabels } from './labels.js';
import { all, one } from './connection.js';

type RunnerRow = Omit<Runner, 'labels' | 'hiddenFromQueue'> & {
  queueHiddenAt: number | null;
};

const RUNNER_SELECT_SQL = `
  SELECT
    r.id,
    r.runner_number AS runnerNumber,
    r.name,
    r.target_laps AS targetLaps,
    r.historical_avg_ms AS historicalAvgMs,
    r.historical_best_ms AS historicalBestMs,
    r.registration_source AS registrationSource,
    r.notes,
    r.created_at AS createdAt,
    r.updated_at AS updatedAt,
    COALESCE(q.status, 'registered') AS status,
    q.status_since AS statusSince,
    q.queue_index AS queueIndex,
    q.hidden_at AS queueHiddenAt,
    COUNT(l.id) AS lapCount,
    MAX(l.duration_ms) AS slowestLapMs,
    MIN(l.duration_ms) AS bestLapMs,
    CASE WHEN COUNT(l.id) = 0 THEN NULL ELSE ROUND(AVG(l.duration_ms)) END AS averageLapMs,
    COALESCE(SUM(l.duration_ms), 0) AS totalTimeMs,
    (
      SELECT duration_ms
      FROM laps last_lap
      WHERE last_lap.runner_id = r.id
      ORDER BY last_lap.finished_at DESC
      LIMIT 1
    ) AS lastLapMs
  FROM runners r
  LEFT JOIN queue_entries q ON q.runner_id = r.id
  LEFT JOIN laps l ON l.runner_id = r.id
`;

function runnerFromRow(row: RunnerRow, labels: Label[]): Runner {
  return {
    id: row.id,
    runnerNumber: row.runnerNumber ?? null,
    name: row.name,
    targetLaps: row.targetLaps ?? null,
    historicalAvgMs: row.historicalAvgMs ?? null,
    historicalBestMs: row.historicalBestMs ?? null,
    registrationSource: cleanRegistrationSource(row.registrationSource),
    notes: row.notes ?? '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: cleanStatus(row.status),
    statusSince: row.statusSince ?? null,
    queueIndex: row.queueIndex ?? null,
    hiddenFromQueue: row.queueHiddenAt !== null && row.queueHiddenAt !== undefined,
    queueHiddenAt: row.queueHiddenAt ?? null,
    labels,
    lapCount: Number(row.lapCount || 0),
    lastLapMs: row.lastLapMs ?? null,
    bestLapMs: row.bestLapMs ?? null,
    slowestLapMs: row.slowestLapMs ?? null,
    averageLapMs: row.averageLapMs ?? null,
    totalTimeMs: Number(row.totalTimeMs || 0),
  };
}

export function getAllRunners(): Runner[] {
  const labelsByRunner = getRunnerLabelsMap();
  const rows = all<RunnerRow>(
    `${RUNNER_SELECT_SQL}
     GROUP BY r.id
     ORDER BY
       CASE COALESCE(q.status, 'registered')
         WHEN 'running' THEN 0
         WHEN 'waiting' THEN 1
         WHEN 'warming_up' THEN 2
         WHEN 'ran' THEN 3
         ELSE 4
       END,
       q.queue_index,
       r.name`
  );

  return rows.map((row) => runnerFromRow(row, labelsByRunner.get(row.id) ?? []));
}

export function getRunnerById(id: string): Runner | null {
  const row = one<RunnerRow>(
    `${RUNNER_SELECT_SQL}
     WHERE r.id = ?
     GROUP BY r.id`,
    [id]
  );
  return row ? runnerFromRow(row, getRunnerLabels(id)) : null;
}

export function getRunnersByIds(ids: string[]): Runner[] {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const labelsByRunner = getRunnerLabelsMap();
  const rows = all<RunnerRow>(
    `${RUNNER_SELECT_SQL}
     WHERE r.id IN (${placeholders})
     GROUP BY r.id`,
    uniqueIds
  );
  return rows.map((row) => runnerFromRow(row, labelsByRunner.get(row.id) ?? []));
}
