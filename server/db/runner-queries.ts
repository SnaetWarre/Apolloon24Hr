import { runnerRegistrationSchema, type Label, type Runner, type RunnerRegistration } from '../../shared/schemas.js';
import { all, one } from './connection.js';
import { getRunnerLabels, getRunnerLabelsMap } from './labels.js';

type RunnerRow = Omit<Runner, 'labels' | 'hiddenFromQueue' | 'notes' | 'estimatedPace'> & {
  notes: string | null;
  estimatedPace: string | null;
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
    json_extract(r.registration_json, '$.estimatedPace') AS estimatedPace,
    r.created_at AS createdAt,
    r.updated_at AS updatedAt,
    r.status,
    r.status_since AS statusSince,
    r.queue_index AS queueIndex,
    r.hidden_at AS queueHiddenAt,
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
  LEFT JOIN laps l ON l.runner_id = r.id
`;

function runnerFromRow(row: RunnerRow, labels: Label[]): Runner {
  return {
    ...row,
    notes: row.notes ?? '',
    estimatedPace: row.estimatedPace || null,
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
       CASE r.status
         WHEN 'running' THEN 0
         WHEN 'waiting' THEN 1
         WHEN 'warming_up' THEN 2
         WHEN 'ran' THEN 3
         ELSE 4
       END,
       r.queue_index,
       r.name`
  ).map((row) => runnerFromRow(row, labelsByRunner.get(row.id) ?? []));
}

export function countRunners(): number {
  return one<{ count: number }>('SELECT COUNT(*) AS count FROM runners')?.count ?? 0;
}

export function getRunnerById(id: string): Runner | null {
  const row = one<RunnerRow>(`${RUNNER_SELECT_SQL} WHERE r.id = ? GROUP BY r.id`, [id]);
  return row ? runnerFromRow(row, getRunnerLabels(id)) : null;
}

/** Registration form answers (contact details included), kept out of the live snapshot. */
export function getRunnerRegistrations(): Record<string, RunnerRegistration> {
  const registrations: Record<string, RunnerRegistration> = {};
  for (const row of all<{ id: string; registrationJson: string }>(
    'SELECT id, registration_json AS registrationJson FROM runners WHERE registration_json IS NOT NULL'
  )) {
    try {
      registrations[row.id] = runnerRegistrationSchema.parse(JSON.parse(row.registrationJson));
    } catch {
      // A malformed stored answer is left out rather than failing the whole list.
    }
  }
  return registrations;
}
