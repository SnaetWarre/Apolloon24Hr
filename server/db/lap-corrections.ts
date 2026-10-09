import { randomUUID } from 'node:crypto';
import { all, one, run } from './connection.js';
import { compareLabels } from '../../shared/labelOrder.js';
import { type Label } from '../../shared/schemas.js';
import { TEMPORARY_TEAM_KIND, getRunnerLabels } from './labels.js';
import { parseLabelsJson, serializeHistoricalLabels } from './values.js';

/*
 * Fixing a lap after the fact, from Beheer › Rondes: a lap that went to the wrong
 * runner, one missed press that made two laps into one, or a press too many. Each
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

/** The labels a lap of `runnerId` started at `startedAt` carries, night teams included. */
function labelsJson(runnerId: string, startedAt: number): string {
  return serializeHistoricalLabels(getRunnerLabels(runnerId, startedAt));
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

/** Gives a lap to another runner, with that runner's labels at the lap's start. */
export function moveLap(lapId: string, runnerId: string): { ok: true } {
  const lap = lapRow(lapId);
  assertRunner(runnerId);
  if (lap.runnerId === runnerId) throw new Error('Deze ronde staat al op die loper.');
  run('UPDATE laps SET runner_id = ?, labels_json = ? WHERE id = ?', [
    runnerId,
    labelsJson(runnerId, lap.startedAt),
    lapId,
  ]);
  renumberLaps(lap.runnerId);
  renumberLaps(runnerId);
  return { ok: true };
}

/**
 * The labels of a split lap's second half. Another runner gets their labels at the middle.
 * The same runner keeps the labels the lap was recorded with, so correcting a missed press
 * never moves a past lap to the runner's current category; only a night team that starts
 * or ends between the start and the middle takes or gives back the speedteam's place.
 */
function secondHalfLabels(lap: LapRow, runnerId: string, middle: number): string {
  if (runnerId !== lap.runnerId) return labelsJson(runnerId, middle);
  const isTeam = (label: Label) => label.kind === TEMPORARY_TEAM_KIND || label.kind === 'speedteam';
  const teamIds = (labels: Label[]) =>
    labels
      .filter((label) => label.kind === TEMPORARY_TEAM_KIND)
      .map((label) => label.id)
      .join();
  const atMiddle = getRunnerLabels(runnerId, middle);
  if (teamIds(getRunnerLabels(runnerId, lap.startedAt)) === teamIds(atMiddle)) return lap.labelsJson;
  const recorded = parseLabelsJson(lap.labelsJson).filter((label) => !isTeam(label));
  return serializeHistoricalLabels([...recorded, ...atMiddle.filter(isTeam)].sort(compareLabels));
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
      secondHalfLabels(lap, runnerId, middle),
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
