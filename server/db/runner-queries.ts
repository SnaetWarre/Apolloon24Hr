import { runnerRegistrationSchema, type Label, type Runner } from '../../shared/schemas.js';
import { all, one } from './connection.js';
import { getRunnerLabels, getRunnerLabelsMap } from './labels.js';
import { cleanRegistrationSource, cleanStatus } from './values.js';

type RunnerRow = Omit<Runner, 'labels' | 'hiddenFromQueue' | 'registration' | 'notes'> & {
  notes: string | null;
  registrationJson: string | null;
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
    r.registration_json AS registrationJson,
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

function parseRegistration(value: string | null): Runner['registration'] {
  if (!value) return null;
  try {
    return runnerRegistrationSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

function runnerFromRow({ registrationJson, ...row }: RunnerRow, labels: Label[]): Runner {
  return {
    ...row,
    registrationSource: cleanRegistrationSource(row.registrationSource),
    notes: row.notes ?? '',
    registration: parseRegistration(registrationJson),
    status: cleanStatus(row.status),
    hiddenFromQueue: row.queueHiddenAt !== null,
    labels,
  };
}

export function getAllRunners(): Runner[] {
  const labelsByRunner = getRunnerLabelsMap();
  return all<RunnerRow>(
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
  ).map((row) => runnerFromRow(row, labelsByRunner.get(row.id) ?? []));
}

export function getRunnerById(id: string): Runner | null {
  const row = one<RunnerRow>(`${RUNNER_SELECT_SQL} WHERE r.id = ? GROUP BY r.id`, [id]);
  return row ? runnerFromRow(row, getRunnerLabels(id)) : null;
}

export function getRunnersByIds(ids: string[]): Runner[] {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return [];
  const labelsByRunner = getRunnerLabelsMap();
  return all<RunnerRow>(
    `${RUNNER_SELECT_SQL}
     WHERE r.id IN (${uniqueIds.map(() => '?').join(', ')})
     GROUP BY r.id`,
    uniqueIds
  ).map((row) => runnerFromRow(row, labelsByRunner.get(row.id) ?? []));
}
