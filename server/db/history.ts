import { one, all } from './connection.js';
import { type RaceState, type LapRecord, type RaceEvent } from '../../shared/schemas.js';
import { parseLabelsJson, boundedHistoryLimit, cleanRaceEventType } from './values.js';

export function getLapCount(runnerId: string): number {
  const row = one<{ count: number }>('SELECT COUNT(*) AS count FROM laps WHERE runner_id = ?', [runnerId]);
  return Number(row?.count || 0);
}

export function getRaceState(): RaceState {
  const row = one<Omit<RaceState, 'id' | 'activeLabels'> & { id: 1; activeLabelsJson: string | null }>(
    `SELECT
      id,
      active_runner_id AS activeRunnerId,
      active_started_at AS activeStartedAt,
      race_started_at AS raceStartedAt,
      race_finished_at AS raceFinishedAt,
      active_labels_json AS activeLabelsJson
     FROM race_state
     WHERE id = 1`
  );
  return {
    id: 1,
    activeRunnerId: row?.activeRunnerId ?? null,
    activeStartedAt: row?.activeStartedAt ?? null,
    raceStartedAt: row?.raceStartedAt ?? null,
    raceFinishedAt: row?.raceFinishedAt ?? null,
    activeLabels: parseLabelsJson(row?.activeLabelsJson),
  };
}

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

function lapFromRow({ labelsJson, ...lap }: LapRow): LapRecord {
  return { ...lap, labels: parseLabelsJson(labelsJson) };
}

export function getAllLaps(): LapRecord[] {
  return all<LapRow>(`${LAP_SELECT_SQL} ORDER BY l.finished_at DESC`).map(lapFromRow);
}

export function getRecentLaps(limit = 100): LapRecord[] {
  const safeLimit = boundedHistoryLimit(limit);
  return all<LapRow>(
    `${LAP_SELECT_SQL} ORDER BY l.finished_at DESC LIMIT ?`,
    [safeLimit]
  ).map(lapFromRow);
}

export function getLapsForRunner(runnerId: string): LapRecord[] {
  return all<LapRow>(
    `${LAP_SELECT_SQL} WHERE l.runner_id = ? ORDER BY l.finished_at DESC`,
    [runnerId]
  ).map(lapFromRow);
}

export function getLapById(id: string): LapRecord | null {
  const row = one<LapRow>(`${LAP_SELECT_SQL} WHERE l.id = ?`, [id]);
  return row ? lapFromRow(row) : null;
}

export function getAllRaceEvents(): RaceEvent[] {
  return all<RaceEvent>(
    `SELECT
      id,
      type,
      message,
      occurred_at AS occurredAt,
      created_at AS createdAt,
      runner_id AS runnerId,
      runner_number AS runnerNumber,
      runner_name AS runnerName
    FROM race_events
    ORDER BY occurred_at DESC, created_at DESC`
  ).map((event) => ({
    ...event,
    type: cleanRaceEventType(event.type),
    runnerId: event.runnerId ?? null,
    runnerNumber: event.runnerNumber ?? null,
    runnerName: event.runnerName ?? null,
  }));
}

export function getRecentRaceEvents(limit = 100): RaceEvent[] {
  const safeLimit = boundedHistoryLimit(limit);
  return all<RaceEvent>(
    `SELECT
      id,
      type,
      message,
      occurred_at AS occurredAt,
      created_at AS createdAt,
      runner_id AS runnerId,
      runner_number AS runnerNumber,
      runner_name AS runnerName
    FROM race_events
    ORDER BY occurred_at DESC, created_at DESC
    LIMIT ?`,
    [safeLimit]
  ).map((event) => ({
    ...event,
    type: cleanRaceEventType(event.type),
    runnerId: event.runnerId ?? null,
    runnerNumber: event.runnerNumber ?? null,
    runnerName: event.runnerName ?? null,
  }));
}

export function getRaceEventById(id: string): RaceEvent | null {
  const event = one<RaceEvent>(
    `SELECT
       id,
       type,
       message,
       occurred_at AS occurredAt,
       created_at AS createdAt,
       runner_id AS runnerId,
       runner_number AS runnerNumber,
       runner_name AS runnerName
     FROM race_events
     WHERE id = ?`,
    [id]
  );
  return event
    ? {
        ...event,
        type: cleanRaceEventType(event.type),
        runnerId: event.runnerId ?? null,
        runnerNumber: event.runnerNumber ?? null,
        runnerName: event.runnerName ?? null,
      }
    : null;
}
