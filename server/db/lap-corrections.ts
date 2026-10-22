import { randomUUID } from 'node:crypto';
import { MAX_HANDOFF_SHIFT_MS, MIN_LAP_MS } from '../../shared/lapTimes.js';
import { clusterNow } from '../clock.js';
import { all, one, run } from './connection.js';
import { getRunnerLabels } from './labels.js';
import { getRaceState } from './race-state.js';
import { serializeHistoricalLabels } from './values.js';

/*
 * Fixing a lap after the fact, from Beheer › Rondes: a lap that went to the wrong
 * runner, one missed press that made two laps into one, a press too many, or a press
 * that came too late or too early. Each
 * runner's laps are numbered again by start time afterwards, so the numbers stay
 * 1, 2, 3 in the order they were run.
 */

type LapRow = {
  id: string;
  runnerId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  createdAt: number;
  labelsJson: string;
};

function lapRow(lapId: string): LapRow {
  const lap = one<LapRow>(
    `SELECT id, runner_id AS runnerId, started_at AS startedAt, finished_at AS finishedAt,
       duration_ms AS durationMs, created_at AS createdAt, labels_json AS labelsJson
     FROM laps WHERE id = ?`,
    [lapId]
  );
  if (!lap) throw new Error('Deze ronde bestaat niet meer. Vernieuw de lijst.');
  return lap;
}

function assertRunner(runnerId: string): void {
  if (!one<{ id: string }>('SELECT id FROM runners WHERE id = ?', [runnerId])) throw new Error('Loper niet gevonden');
}

/** The labels a lap of `runnerId` carries. */
function labelsJson(runnerId: string): string {
  return serializeHistoricalLabels(getRunnerLabels(runnerId));
}

function renumberLaps(runnerId: string): void {
  run(
    `UPDATE laps SET lap_number = (
       SELECT COUNT(*) FROM laps earlier
       WHERE earlier.runner_id = laps.runner_id
         AND (earlier.started_at < laps.started_at OR (earlier.started_at = laps.started_at AND earlier.id <= laps.id))
     )
     WHERE runner_id = ?`,
    [runnerId]
  );
}

/** Gives a lap to another runner, with that runner's labels. */
export function moveLap(lapId: string, runnerId: string): { ok: true } {
  const lap = lapRow(lapId);
  assertRunner(runnerId);
  if (lap.runnerId === runnerId) throw new Error('Deze ronde staat al op die loper.');
  run('UPDATE laps SET runner_id = ?, labels_json = ? WHERE id = ?', [runnerId, labelsJson(runnerId), lapId]);
  renumberLaps(lap.runnerId);
  renumberLaps(runnerId);
  return { ok: true };
}

/**
 * The labels of a split lap's second half. Another runner gets their own labels. The same
 * runner keeps the labels the lap was recorded with, so correcting a missed press never
 * moves a past lap to the runner's current category.
 */
function secondHalfLabels(lap: LapRow, runnerId: string): string {
  return runnerId === lap.runnerId ? lap.labelsJson : labelsJson(runnerId);
}

/**
 * Splits a lap in two halves, for a press that was missed: the first half stays
 * with its runner, the second goes to `runnerId` (the same runner when they ran
 * twice). Nobody pressed in between, so the middle is the best guess, and both
 * halves are marked as split: neither time was measured. Undoing the handoff that
 * recorded the lap takes back both halves.
 */
export function splitLap(lapId: string, runnerId: string): { ok: true; lapIds: [string, string] } {
  const lap = lapRow(lapId);
  assertRunner(runnerId);
  if (lap.durationMs < 2) throw new Error('Deze ronde is te kort om te splitsen.');
  const firstMs = Math.round(lap.durationMs / 2);
  const middle = lap.startedAt + firstMs;
  const secondId = randomUUID();
  run("UPDATE laps SET finished_at = ?, duration_ms = ?, source = 'split' WHERE id = ?", [middle, firstMs, lapId]);
  run(
    `INSERT INTO laps (id, runner_id, lap_number, started_at, finished_at, duration_ms, source, created_at, labels_json)
     VALUES (?, ?, 0, ?, ?, ?, 'split', ?, ?)`,
    [
      secondId,
      runnerId,
      middle,
      lap.finishedAt,
      lap.durationMs - firstMs,
      lap.createdAt,
      secondHalfLabels(lap, runnerId),
    ]
  );
  for (const handoff of all<{ id: string; payloadJson: string }>(
    `SELECT id, payload_json AS payloadJson FROM handoff_history WHERE undone = 0 AND payload_json LIKE ?`,
    [`%${lapId}%`]
  )) {
    const payload = JSON.parse(handoff.payloadJson) as { lapIds?: string[] };
    if (!payload.lapIds?.includes(lapId)) continue;
    payload.lapIds.push(secondId);
    run('UPDATE handoff_history SET payload_json = ? WHERE id = ?', [JSON.stringify(payload), handoff.id]);
  }
  renumberLaps(lap.runnerId);
  if (runnerId !== lap.runnerId) renumberLaps(runnerId);
  return { ok: true, lapIds: [lapId, secondId] };
}

/** Removes a lap that should not count, such as one press too many. */
export function deleteLap(lapId: string): { ok: true } {
  const lap = lapRow(lapId);
  run('DELETE FROM laps WHERE id = ?', [lapId]);
  renumberLaps(lap.runnerId);
  return { ok: true };
}

/**
 * Moves the press that ended a lap, for a press that came too late or too early. The lap
 * ends at `to` instead of `from`, and the lap that started at that press, or the runner on
 * the track now, starts at `to`. Their two times add up as before and no other lap changes.
 * `from` is the press the operator saw, so a press someone else moved meanwhile is not moved twice.
 */
export function moveHandoff(lapId: string, from: number, to: number): { ok: true } {
  const lap = lapRow(lapId);
  if (lap.finishedAt !== from) throw new Error('Deze wissel is intussen veranderd. Bekijk hem opnieuw.');
  const shift = to - from;
  if (shift === 0) return { ok: true };
  if (Math.abs(shift) > MAX_HANDOFF_SHIFT_MS) {
    throw new Error(`Een wissel schuift hoogstens ${MAX_HANDOFF_SHIFT_MS / 1000} seconden.`);
  }
  const next = one<LapRow>(
    `SELECT id, runner_id AS runnerId, started_at AS startedAt, finished_at AS finishedAt,
       duration_ms AS durationMs, created_at AS createdAt, labels_json AS labelsJson
     FROM laps WHERE started_at = ? AND id <> ? LIMIT 1`,
    [from, lapId]
  );
  const race = getRaceState();
  const runningId = !next && race.activeStartedAt === from ? race.activeRunnerId : null;
  if (!next && !runningId) throw new Error('Na deze ronde begon niemand een nieuwe ronde.');
  const nextMs = next ? next.durationMs : clusterNow() - from;
  // A lap may not end up a double press, unless it already was one.
  if (lap.durationMs + shift < Math.min(MIN_LAP_MS, lap.durationMs) || nextMs - shift < Math.min(MIN_LAP_MS, nextMs)) {
    throw new Error(`Zo wordt een ronde korter dan ${MIN_LAP_MS / 1000} seconden.`);
  }
  run('UPDATE laps SET finished_at = ?, duration_ms = ? WHERE id = ?', [to, lap.durationMs + shift, lapId]);
  if (next) run('UPDATE laps SET started_at = ?, duration_ms = ? WHERE id = ?', [to, next.durationMs - shift, next.id]);
  else run('UPDATE race_state SET active_started_at = ? WHERE id = 1', [to]);
  const nextRunnerId = next?.runnerId ?? runningId;
  run('UPDATE runners SET status_since = ? WHERE status_since = ? AND id IN (?, ?)', [
    to,
    from,
    lap.runnerId,
    nextRunnerId,
  ]);
  // Undoing the handoff after this one puts its runner back on the track from the moved press.
  for (const handoff of all<{ id: string; payloadJson: string }>(
    `SELECT id, payload_json AS payloadJson FROM handoff_history WHERE undone = 0 AND payload_json LIKE ?`,
    [`%"activeStartedAt":${from}%`]
  )) {
    const payload = JSON.parse(handoff.payloadJson) as { raceState?: { activeStartedAt?: number | null } };
    if (payload.raceState?.activeStartedAt !== from) continue;
    payload.raceState.activeStartedAt = to;
    run('UPDATE handoff_history SET payload_json = ? WHERE id = ?', [JSON.stringify(payload), handoff.id]);
  }
  return { ok: true };
}
