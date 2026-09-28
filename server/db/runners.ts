import { v4 as uuidv4 } from 'uuid';
import { type Runner, type RunnerInput, type RunnerPatch } from '../../shared/schemas.js';
import { one, run, transaction } from './connection.js';
import { TEMPORARY_TEAM_KIND, ensureLabel, getLabels } from './labels.js';
import { getMaxQueueIndex } from './queue.js';
import { clearActiveRunner } from './race-state.js';
import { getRunnerById } from './runner-queries.js';
import { cleanInt, cleanRegistrationSource, cleanStatus, cleanText } from './values.js';

type StoredRunner = {
  runner_number: string | null;
  name: string;
  target_laps: number | null;
  historical_avg_ms: number | null;
  historical_best_ms: number | null;
  registration_source: string;
  notes: string | null;
  registration_json: string | null;
};

function getActiveTemporaryTeamLabelIdForRunner(runnerId: string): string | null {
  return (
    one<{ labelId: string }>(
      `SELECT ttm.team_label_id AS labelId
       FROM temporary_team_members ttm
       JOIN temporary_teams tt ON tt.label_id = ttm.team_label_id
       WHERE ttm.runner_id = ? AND tt.active = 1`,
      [runnerId]
    )?.labelId ?? null
  );
}

function findRunnerIdByNumber(runnerNumber: string): string | null {
  return one<{ id: string }>('SELECT id FROM runners WHERE runner_number = ?', [runnerNumber])?.id ?? null;
}

function findRunnerIdByEmail(email: string): string | null {
  return (
    one<{ id: string }>(
      "SELECT id FROM runners WHERE lower(json_extract(registration_json, '$.email')) = lower(?) LIMIT 1",
      [email]
    )?.id ?? null
  );
}

/**
 * Replaces the runner's labels. Values may be label ids or names; unknown names
 * create a label. A temporary team label is only kept while that team is active.
 */
export function setRunnerLabels(runnerId: string, labelNamesOrIds: string[]): void {
  run('DELETE FROM runner_labels WHERE runner_id = ?', [runnerId]);
  const activeTemporaryLabelId = getActiveTemporaryTeamLabelIdForRunner(runnerId);
  for (const value of labelNamesOrIds) {
    const labelText = cleanText(value);
    if (!labelText) continue;
    const label =
      one<{ id: string; kind: string }>('SELECT id, kind FROM labels WHERE id = ?', [labelText]) ??
      ensureLabel(labelText);
    if (!label) continue;
    if (label.kind === TEMPORARY_TEAM_KIND && label.id !== activeTemporaryLabelId) continue;
    run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [runnerId, label.id]);
  }
}

export function insertRunner(input: RunnerInput): Runner {
  const name = cleanText(input.name);
  if (!name) throw new Error('runner name required');

  const initialStatus = cleanStatus(input.status);
  if (initialStatus === 'running') {
    throw new Error('Start een nieuwe loper via het timingscherm');
  }
  const now = Date.now();
  const id = input.id || uuidv4();
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
        registration_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        cleanText(input.runnerNumber),
        name,
        cleanInt(input.targetLaps),
        cleanInt(input.historicalAvgMs),
        cleanInt(input.historicalBestMs),
        cleanRegistrationSource(input.registrationSource),
        cleanText(input.notes) || '',
        input.registration ? JSON.stringify(input.registration) : null,
        now,
        now,
      ]
    );
    run(
      `INSERT INTO queue_entries (runner_id, status, queue_index, status_since, hidden_at)
       VALUES (?, ?, ?, ?, NULL)`,
      [id, initialStatus, initialQueueIndex, cleanInt(input.statusSince) ?? now]
    );
    setRunnerLabels(id, input.labels ?? []);
  });
  const runner = getRunnerById(id);
  if (!runner) throw new Error('runner insert failed');
  return runner;
}

export function updateRunner(id: string, fields: RunnerPatch): Runner | null {
  const current = one<StoredRunner>('SELECT * FROM runners WHERE id = ?', [id]);
  if (!current) return null;

  if (fields.labels !== undefined) {
    const activeTemporaryLabelId = getActiveTemporaryTeamLabelIdForRunner(id);
    if (activeTemporaryLabelId) {
      const requested = new Set(fields.labels);
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
    registrationSource: cleanRegistrationSource(fields.registrationSource ?? current.registration_source),
    notes: fields.notes !== undefined ? cleanText(fields.notes) || '' : current.notes || '',
    registrationJson:
      fields.registration !== undefined
        ? fields.registration
          ? JSON.stringify(fields.registration)
          : null
        : current.registration_json,
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
           registration_json = ?,
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
        next.registrationJson,
        Date.now(),
        id,
      ]
    );
    if (fields.labels !== undefined) {
      setRunnerLabels(id, fields.labels);
    }
  });

  return getRunnerById(id);
}

/**
 * Imports match an existing runner by registration e-mail, else by runner
 * number. A form re-import keeps the operator's number, notes, and labels,
 * because the row's position in the sheet can change between exports.
 */
export function upsertRunnerFromImport(input: RunnerInput): { action: 'created' | 'updated'; runner: Runner } {
  const runnerNumber = cleanText(input.runnerNumber);
  const email = cleanText(input.registration?.email);
  const existingId = email ? findRunnerIdByEmail(email) : runnerNumber ? findRunnerIdByNumber(runnerNumber) : null;
  if (existingId) {
    const { status: _status, statusSince: _statusSince, ...profileFields } = input;
    if (email) {
      delete profileFields.runnerNumber;
      delete profileFields.notes;
      delete profileFields.labels;
    }
    const runner = updateRunner(existingId, profileFields);
    if (!runner) throw new Error('runner update failed');
    return { action: 'updated', runner };
  }
  return {
    action: 'created',
    runner: insertRunner({ ...input, status: 'registered', registrationSource: 'import' }),
  };
}

export function deleteRunner(id: string): void {
  transaction(() => {
    run('DELETE FROM runner_labels WHERE runner_id = ?', [id]);
    run('DELETE FROM laps WHERE runner_id = ?', [id]);
    run('DELETE FROM queue_entries WHERE runner_id = ?', [id]);
    clearActiveRunner(id);
    run('DELETE FROM runners WHERE id = ?', [id]);
  });
}
