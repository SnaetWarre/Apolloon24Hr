import { one, run, transaction } from './connection.js';
import { cleanText, cleanStatus, cleanInt, cleanRegistrationSource } from './values.js';
import { ensureLabel, TEMPORARY_TEAM_KIND, getLabels } from './labels.js';
import { type RunnerInput, type Runner, type RunnerPatch, type RegistrationSource } from '../../shared/schemas.js';
import { v4 as uuidv4 } from 'uuid';
import { getMaxQueueIndex } from './queue.js';
import { getRunnerById } from './runner-queries.js';

function getActiveTemporaryTeamLabelIdForRunner(runnerId: string): string | null {
  const row = one<{ labelId: string }>(
    `SELECT ttm.team_label_id AS labelId
     FROM temporary_team_members ttm
     JOIN temporary_teams tt ON tt.label_id = ttm.team_label_id
     WHERE ttm.runner_id = ? AND tt.active = 1`,
    [runnerId]
  );
  return row?.labelId ?? null;
}

function findRunnerByNumber(runnerNumber: unknown): { id: string } | null {
  const number = cleanText(runnerNumber);
  if (!number) return null;
  return one<{ id: string }>('SELECT id FROM runners WHERE runner_number = ?', [number]);
}

export function setRunnerLabels(runnerId: string, labelNamesOrIds: unknown): void {
  run('DELETE FROM runner_labels WHERE runner_id = ?', [runnerId]);
  const labels = Array.isArray(labelNamesOrIds) ? labelNamesOrIds : [];
  const activeTemporaryLabelId = getActiveTemporaryTeamLabelIdForRunner(runnerId);
  for (const labelValue of labels) {
    const labelText = cleanText(labelValue);
    if (!labelText) continue;
    const existingById = one<{ id: string; kind: string }>('SELECT id, kind FROM labels WHERE id = ?', [labelText]);
    const label = existingById || ensureLabel(labelText);
    if (!label) continue;
    if (label.kind === TEMPORARY_TEAM_KIND && label.id !== activeTemporaryLabelId) continue;
    run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [runnerId, label.id]);
  }
}

export function insertRunner(input: RunnerInput): Runner {
  const name = cleanText(input.name);
  if (!name) throw new Error('runner name required');

  const now = Date.now();
  const id = input.id || uuidv4();
  const initialStatus = cleanStatus(input.status);
  if (initialStatus === 'running') {
    throw new Error('Start een nieuwe loper via het timingscherm');
  }
  const initialQueueIndex = initialStatus === 'waiting' ? getMaxQueueIndex() + 1 : null;
  transaction(() => {
    run(
      `INSERT INTO runners (
        id,
        runner_number,
        name,
        target_laps,
        historical_avg_ms,
        historical_best_ms,
        registration_source,
        notes,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        cleanText(input.runnerNumber),
        name,
        cleanInt(input.targetLaps),
        cleanInt(input.historicalAvgMs),
        cleanInt(input.historicalBestMs),
        cleanRegistrationSource(input.registrationSource),
        cleanText(input.notes) || '',
        now,
        now,
      ]
    );
    run(
      `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
       VALUES (?, ?, ?, ?, NULL)`,
      [id, initialStatus, initialQueueIndex, cleanInt(input.statusSince) ?? now]
    );
    setRunnerLabels(id, input.labels || []);
  });
  const runner = getRunnerById(id);
  if (!runner) throw new Error('runner insert failed');
  return runner;
}

export function updateRunner(id: string, fields: RunnerPatch): Runner | null {
  const current = one<{
    runner_number: string | null;
    name: string;
    target_laps: number | null;
    historical_avg_ms: number | null;
    historical_best_ms: number | null;
    registration_source: RegistrationSource;
    notes: string | null;
  }>('SELECT * FROM runners WHERE id = ?', [id]);
  if (!current) return null;

  if (fields.labels !== undefined) {
    const activeTemporaryLabelId = getActiveTemporaryTeamLabelIdForRunner(id);
    if (activeTemporaryLabelId) {
      const requested = new Set(fields.labels.map((value) => String(value)));
      const hasOrdinarySpeedteam = getLabels().some(
        (label) => label.kind === 'speedteam' && requested.has(label.id)
      );
      if (!requested.has(activeTemporaryLabelId) || hasOrdinarySpeedteam) {
        throw new Error('De speedteamploeg ligt vast zolang de tijdelijke nachtploeg actief is');
      }
    }
  }

  const next = {
    runnerNumber: fields.runnerNumber !== undefined ? cleanText(fields.runnerNumber) : current.runner_number,
    name: fields.name !== undefined ? cleanText(fields.name) || current.name : current.name,
    targetLaps: fields.targetLaps !== undefined ? cleanInt(fields.targetLaps) : current.target_laps,
    historicalAvgMs:
      fields.historicalAvgMs !== undefined ? cleanInt(fields.historicalAvgMs) : current.historical_avg_ms,
    historicalBestMs:
      fields.historicalBestMs !== undefined ? cleanInt(fields.historicalBestMs) : current.historical_best_ms,
    registrationSource:
      fields.registrationSource !== undefined
        ? cleanRegistrationSource(fields.registrationSource)
        : cleanRegistrationSource(current.registration_source),
    notes: fields.notes !== undefined ? cleanText(fields.notes) || '' : current.notes || '',
    updatedAt: Date.now(),
  };

  transaction(() => {
    run(
      `UPDATE runners
       SET runner_number = ?,
           name = ?,
           target_laps = ?,
           historical_avg_ms = ?,
           historical_best_ms = ?,
           registration_source = ?,
           notes = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        next.runnerNumber,
        next.name,
        next.targetLaps,
        next.historicalAvgMs,
        next.historicalBestMs,
        next.registrationSource,
        next.notes,
        next.updatedAt,
        id,
      ]
    );
    if (fields.labels !== undefined) {
      setRunnerLabels(id, fields.labels);
    }
  });

  return getRunnerById(id);
}

export function upsertRunnerFromImport(input: RunnerInput): { action: 'created' | 'updated'; runner: Runner } {
  const runnerNumber = cleanText(input.runnerNumber);
  const existing = runnerNumber ? findRunnerByNumber(runnerNumber) : null;
  if (existing) {
    const { status: _status, statusSince: _statusSince, ...profileFields } = input;
    const runner = updateRunner(existing.id, profileFields);
    if (!runner) throw new Error('runner update failed');
    return { action: 'updated', runner };
  }
  return {
    action: 'created',
    runner: insertRunner({
      ...input,
      status: 'registered',
      registrationSource: 'import',
    }),
  };
}

export function deleteRunner(id: string): void {
  transaction(() => {
    run('DELETE FROM runner_labels WHERE runner_id = ?', [id]);
    run('DELETE FROM laps WHERE runner_id = ?', [id]);
    run('DELETE FROM queue_entries WHERE runner_id = ?', [id]);
    run(
      `UPDATE race_state
       SET active_runner_id = NULL, active_started_at = NULL, active_labels_json = NULL
       WHERE active_runner_id = ?`,
      [id]
    );
    run('DELETE FROM runners WHERE id = ?', [id]);
  });
}
