import { type LapRecord, type RaceEvent } from '../../shared/schemas.js';
import { all, one } from './connection.js';
import { boundedHistoryLimit, parseLabelsJson } from './values.js';

type LapRow = Omit<LapRecord, 'labels'> & { labelsJson: string };

const LAP_SELECT_SQL = `
  SELECT
    l.id,
    l.runner_id AS runnerId,
    r.runner_number AS runnerNumber,
    r.name AS runnerName,
    l.lap_number AS lapNumber,
    l.started_at AS startedAt,
    l.finished_at AS finishedAt,
    l.duration_ms AS durationMs,
    l.source,
    l.created_at AS createdAt,
    l.labels_json AS labelsJson
  FROM laps l
  JOIN runners r ON r.id = l.runner_id
`;

const RACE_EVENT_SELECT_SQL = `
  SELECT
    id,
    type,
    message,
    occurred_at AS occurredAt,
    created_at AS createdAt,
    runner_id AS runnerId,
    runner_number AS runnerNumber,
    runner_name AS runnerName
  FROM race_events
`;

const RACE_EVENT_ORDER = 'ORDER BY occurred_at DESC, created_at DESC';

function lapFromRow({ labelsJson, ...lap }: LapRow): LapRecord {
  return { ...lap, labels: parseLabelsJson(labelsJson) };
}

export function getLapCount(runnerId: string): number {
  return one<{ count: number }>('SELECT COUNT(*) AS count FROM laps WHERE runner_id = ?', [runnerId])?.count ?? 0;
}

export function getAllLaps(): LapRecord[] {
  return all<LapRow>(`${LAP_SELECT_SQL} ORDER BY l.finished_at DESC`).map(lapFromRow);
}

export function getRecentLaps(limit = 100): LapRecord[] {
  return all<LapRow>(`${LAP_SELECT_SQL} ORDER BY l.finished_at DESC LIMIT ?`, [boundedHistoryLimit(limit)]).map(
    lapFromRow
  );
}

export function getLapsForRunner(runnerId: string): LapRecord[] {
  return all<LapRow>(`${LAP_SELECT_SQL} WHERE l.runner_id = ? ORDER BY l.finished_at DESC`, [runnerId]).map(lapFromRow);
}

export function getAllRaceEvents(): RaceEvent[] {
  return all<RaceEvent>(`${RACE_EVENT_SELECT_SQL} ${RACE_EVENT_ORDER}`);
}

export function getRecentRaceEvents(limit = 100): RaceEvent[] {
  return all<RaceEvent>(`${RACE_EVENT_SELECT_SQL} ${RACE_EVENT_ORDER} LIMIT ?`, [boundedHistoryLimit(limit)]);
}

export function getRaceEventById(id: string): RaceEvent | null {
  return one<RaceEvent>(`${RACE_EVENT_SELECT_SQL} WHERE id = ?`, [id]);
}
