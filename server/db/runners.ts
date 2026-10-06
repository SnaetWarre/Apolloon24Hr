import { randomUUID } from 'node:crypto';
import {
  runnerRegistrationSchema,
  type Runner,
  type RunnerInput,
  type RunnerPatch,
  type RunnerRegistration,
  type RunnerRegistrationDetails,
} from '../../shared/schemas.js';
import { one, run, transaction } from './connection.js';
import { TEMPORARY_TEAM_KIND, activeTemporaryTeamIdForRunner, ensureLabel } from './labels.js';
import { getMaxQueueIndex } from './queue.js';
import { clearActiveRunner } from './race-state.js';
import { getRunnerById } from './runner-queries.js';
import { clusterNow } from '../clock.js';

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

function findRunnerIdBySubmission(submittedAt: string): string | null {
  return (
    one<{ id: string }>("SELECT id FROM runners WHERE json_extract(registration_json, '$.submittedAt') = ? LIMIT 1", [
      submittedAt,
    ])?.id ?? null
  );
}

/** The form's e-mail is typed by hand; answers such as `///` are no address and identify nobody. */
function usableEmail(email: string): string | null {
  const trimmed = email.trim();
  return /^[^\s@]+@[^\s@]+$/.test(trimmed) ? trimmed : null;
}

function findRunnerIdByNumberAndName(runnerNumber: string, name: string): string | null {
  return (
    one<{ id: string }>('SELECT id FROM runners WHERE runner_number = ? AND name = ?', [runnerNumber, name.trim()])
      ?.id ?? null
  );
}

/**
 * The runner an imported row was imported as before. A form answer is known
 * by its e-mail, else by its submission time. A CSV export and the Excel file
 * write that time differently, so last comes the same sheet row and name.
 * A plain runner list is known by its runner number.
 */
function findImportedRunnerId(input: RunnerInput, runnerNumber: string | undefined): string | null {
  const registration = input.registration;
  if (!registration) return runnerNumber ? findRunnerIdByNumber(runnerNumber) : null;
  const email = usableEmail(registration.email);
  const submittedAt = registration.submittedAt.trim();
  return (
    (email && findRunnerIdByEmail(email)) ||
    (submittedAt && findRunnerIdBySubmission(submittedAt)) ||
    (runnerNumber && findRunnerIdByNumberAndName(runnerNumber, input.name)) ||
    null
  );
}

const EMPTY_REGISTRATION: RunnerRegistration = {
  submittedAt: '',
  email: '',
  phone: '',
  studyPhase: '',
  estimatedLaps: '',
  estimatedPace: '',
  maxLapsPerBlock: '',
  availableHours: [],
  reuseConsent: '',
  flexibility: '',
  remarks: '',
  categories: [],
  fastestLap: '',
};

/**
 * Hand-entered contact details and hours on top of the stored registration.
 * A registration left with no answers at all is dropped, so a manual runner
 * reads as "no registration" again.
 */
function registrationJsonWithDetails(
  registrationJson: string | null,
  details: RunnerRegistrationDetails | undefined
): string | null {
  if (!details) return registrationJson;
  const current = registrationJson ? runnerRegistrationSchema.parse(JSON.parse(registrationJson)) : EMPTY_REGISTRATION;
  const next: RunnerRegistration = {
    ...current,
    ...details,
    availableHours: details.availableHours ? [...new Set(details.availableHours)] : current.availableHours,
  };
  const hasAnswers = Object.values(next).some((value) => (Array.isArray(value) ? value.length : value.trim()));
  return hasAnswers ? JSON.stringify(next) : null;
}

const LABEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replaces the runner's stored labels. Values may be label ids or names;
 * unknown names create a label. An unknown id is a label another laptop
 * deleted meanwhile and is skipped, not turned into a name. Night team
 * labels are derived, never stored, and while a night team is active the
 * runner keeps their speedteam.
 */
function setRunnerLabels(runnerId: string, labelNamesOrIds: string[]): void {
  const keepSpeedteam = Boolean(activeTemporaryTeamIdForRunner(runnerId));
  run(
    `DELETE FROM runner_labels WHERE runner_id = ?
     ${keepSpeedteam ? "AND label_id NOT IN (SELECT id FROM labels WHERE kind = 'speedteam')" : ''}`,
    [runnerId]
  );
  for (const value of labelNamesOrIds) {
    const label =
      one<{ id: string; kind: string }>('SELECT id, kind FROM labels WHERE id = ?', [value]) ??
      (LABEL_ID_PATTERN.test(value.trim()) ? null : ensureLabel(value));
    if (!label || label.kind === TEMPORARY_TEAM_KIND || (keepSpeedteam && label.kind === 'speedteam')) continue;
    run('INSERT OR IGNORE INTO runner_labels (runner_id, label_id) VALUES (?, ?)', [runnerId, label.id]);
  }
}

export function insertRunner(input: RunnerInput): Runner {
  const name = input.name.trim();
  if (!name) throw new Error('Een loper heeft een naam nodig');

  const initialStatus = input.status ?? 'registered';
  if (initialStatus === 'running') {
    throw new Error('Start een nieuwe loper via het timingscherm');
  }
  const now = clusterNow();
  const id = input.id || randomUUID();
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
        status,
        queue_index,
        status_since,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.runnerNumber ?? null,
        name,
        input.targetLaps ?? null,
        input.historicalAvgMs ?? null,
        input.historicalBestMs ?? null,
        input.registrationSource ?? 'manual',
        input.notes ?? '',
        registrationJsonWithDetails(
          input.registration ? JSON.stringify(input.registration) : null,
          input.registrationDetails
        ),
        initialStatus,
        initialQueueIndex,
        input.statusSince ?? now,
        now,
        now,
      ]
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

  const next = {
    runnerNumber: fields.runnerNumber !== undefined ? fields.runnerNumber : current.runner_number,
    name: fields.name || current.name,
    targetLaps: fields.targetLaps !== undefined ? fields.targetLaps : current.target_laps,
    historicalAvgMs: fields.historicalAvgMs !== undefined ? fields.historicalAvgMs : current.historical_avg_ms,
    historicalBestMs: fields.historicalBestMs !== undefined ? fields.historicalBestMs : current.historical_best_ms,
    registrationSource: fields.registrationSource ?? current.registration_source,
    notes: fields.notes ?? current.notes ?? '',
    registrationJson: registrationJsonWithDetails(
      fields.registration !== undefined
        ? fields.registration
          ? JSON.stringify(fields.registration)
          : null
        : current.registration_json,
      fields.registrationDetails
    ),
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
        clusterNow(),
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
/**
 * A form answer updates the runner it was imported as before and keeps what
 * operators changed since (number, notes, labels). A new runner whose number
 * is already taken is imported without one, so `numberTaken` asks the
 * operator to pick one.
 */
export function upsertRunnerFromImport(input: RunnerInput): {
  action: 'created' | 'updated';
  runner: Runner;
  numberTaken: boolean;
} {
  const runnerNumber = input.runnerNumber?.trim();
  const existingId = findImportedRunnerId(input, runnerNumber);
  if (existingId) {
    const { status: _status, statusSince: _statusSince, ...profileFields } = input;
    if (input.registration) {
      delete profileFields.runnerNumber;
      delete profileFields.notes;
      delete profileFields.labels;
    }
    const runner = updateRunner(existingId, profileFields);
    if (!runner) throw new Error('runner update failed');
    return { action: 'updated', runner, numberTaken: false };
  }
  const numberTaken = Boolean(runnerNumber && findRunnerIdByNumber(runnerNumber));
  return {
    action: 'created',
    runner: insertRunner({
      ...input,
      runnerNumber: numberTaken ? null : input.runnerNumber,
      status: 'registered',
      registrationSource: 'import',
    }),
    numberTaken,
  };
}

export function deleteRunner(id: string): void {
  transaction(() => {
    run('DELETE FROM runner_labels WHERE runner_id = ?', [id]);
    run('DELETE FROM laps WHERE runner_id = ?', [id]);
    clearActiveRunner(id);
    run('DELETE FROM runners WHERE id = ?', [id]);
  });
}
