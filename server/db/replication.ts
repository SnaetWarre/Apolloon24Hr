import crypto from 'node:crypto';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { type AppSnapshot } from '../../shared/schemas.js';
import {
  compactStoredLapLabels,
  ensureReplicationCheckpoint,
  restoreReplicationCheckpoint,
  storeReplicationCheckpoint,
} from './checkpoint.js';
import {
  DATA_DIR,
  all,
  captureWrite,
  getDb,
  isReplicatedMutation,
  markAppDataChanged,
  one,
  runUncaptured,
  transaction,
} from './connection.js';
import { ensureReplicationIdentity, getReplicationVector, nextLocalHlc, observeRemoteHlc } from './replication-state.js';
import { deleteLocalSetting, getSetting, setLocalSetting, setSetting } from './settings.js';
import { applySnapshot } from './snapshot.js';
import {
  type ReplicatedSqlStatement,
  type ReplicationCheckpoint,
  type ReplicationConflict,
  type ReplicationOperation,
  type SqlValue,
} from './types.js';

const MAX_REPLICATION_ORIGINS = 64;

const TIMING_CONTROLLER_KEY = 'timing_controller_host_id';
const TIMING_GENERATION_KEY = 'timing_controller_generation';

const CANONICAL_ORDER = 'hlc_wall_ms, hlc_counter, origin_host_id, origin_seq';

type ReplicationOperationRow = Omit<ReplicationOperation, 'payload' | 'statements' | 'result'> & {
  payloadJson: string;
  statementsJson: string;
  resultJson: string;
};

const REPLICATION_OPERATION_SELECT = `SELECT
  id,
  cluster_id AS clusterId,
  origin_host_id AS originHostId,
  origin_seq AS originSeq,
  hlc_wall_ms AS hlcWallMs,
  hlc_counter AS hlcCounter,
  type,
  payload_json AS payloadJson,
  statements_json AS statementsJson,
  result_json AS resultJson,
  race_base_key AS raceBaseKey,
  status,
  checksum,
  created_at AS createdAt,
  applied_at AS appliedAt
FROM replication_operations`;

function operationFromRow({ payloadJson, statementsJson, resultJson, ...row }: ReplicationOperationRow): ReplicationOperation {
  return {
    ...row,
    payload: JSON.parse(payloadJson) as unknown,
    statements: JSON.parse(statementsJson) as ReplicatedSqlStatement[],
    result: JSON.parse(resultJson) as unknown,
  };
}

// Timing control is a replicated setting: exactly one laptop records laps.

export function getTimingControllerHostId(): string | null {
  return getSetting(TIMING_CONTROLLER_KEY);
}

export function getTimingControllerGeneration(): number {
  const generation = Number(getSetting(TIMING_GENERATION_KEY) || 0);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

export function assertOrClaimTimingController(): void {
  if (getOpenReplicationConflictCount() > 0) {
    throw new Error('Timing is gepauzeerd door een syncconflict. Los dit eerst op in Admin.');
  }
  const hostId = ensureReplicationIdentity().hostId;
  const current = getTimingControllerHostId();
  if (current && current !== hostId) {
    throw new Error('De timing wordt bediend op een andere laptop');
  }
  assignTimingController(hostId);
}

export function assignTimingController(hostId: string): { hostId: string; generation: number } {
  const targetHostId = hostId.trim();
  if (!targetHostId || targetHostId.length > 128) {
    throw new Error('ongeldige timinglaptop');
  }
  const generation = getTimingControllerGeneration();
  if (getTimingControllerHostId() === targetHostId && generation > 0) {
    return { hostId: targetHostId, generation };
  }
  setSetting(TIMING_CONTROLLER_KEY, targetHostId);
  setSetting(TIMING_GENERATION_KEY, String(generation + 1));
  return { hostId: targetHostId, generation: generation + 1 };
}

function replicationChecksum(operation: Omit<ReplicationOperation, 'checksum' | 'status' | 'appliedAt'>): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        id: operation.id,
        clusterId: operation.clusterId,
        originHostId: operation.originHostId,
        originSeq: operation.originSeq,
        hlcWallMs: operation.hlcWallMs,
        hlcCounter: operation.hlcCounter,
        type: operation.type,
        payload: operation.payload,
        statements: operation.statements,
        result: operation.result,
        raceBaseKey: operation.raceBaseKey,
        createdAt: operation.createdAt,
      })
    )
    .digest('hex');
}

/** `Object.hasOwn`, which the client's ES2020 typecheck of this file does not know. */
function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : nested
  );
}

/**
 * Runs a local write and records it as an immutable operation in the same
 * transaction. Retrying a command id returns the original result; reusing it
 * for another write is rejected.
 */
export function commitReplicatedWrite<T>(input: {
  id?: string;
  type: string;
  payload?: unknown;
  raceBaseKey?: string | null;
  action: () => T;
}): T {
  const identity = ensureReplicationIdentity();
  const id = input.id || uuidv4();
  const existing = getReplicationOperation(id);
  if (existing) {
    if (existing.type !== input.type || stableJson(existing.payload) !== stableJson(input.payload ?? null)) {
      throw new Error('command id was already used for a different write');
    }
    return existing.result as T;
  }

  return transaction(() => {
    ensureReplicationCheckpoint();
    const originSeq =
      (one<{ seq: number }>(
        'SELECT COALESCE(MAX(origin_seq), 0) AS seq FROM replication_operations WHERE origin_host_id = ?',
        [identity.hostId]
      )?.seq ?? 0) + 1;
    const hlc = nextLocalHlc();
    const { result, statements } = captureWrite(input.action);
    const operation = {
      id,
      clusterId: identity.clusterId,
      originHostId: identity.hostId,
      originSeq,
      hlcWallMs: hlc.wallMs,
      hlcCounter: hlc.counter,
      type: input.type,
      payload: input.payload ?? null,
      statements,
      result: result ?? null,
      raceBaseKey: input.raceBaseKey ?? null,
      createdAt: Date.now(),
    };
    insertReplicationOperation({
      ...operation,
      status: 'accepted',
      checksum: replicationChecksum(operation),
      appliedAt: operation.createdAt,
    });
    return result;
  });
}

export function getReplicationOperationsMissing(vector: Record<string, number>, limit = 250): ReplicationOperation[] {
  const origins = all<{ hostId: string }>('SELECT DISTINCT origin_host_id AS hostId FROM replication_operations');
  if (!origins.length) return [];

  const params: SqlValue[] = [];
  const conditions = origins.map(({ hostId }) => {
    const acknowledged = Number(hasOwn(vector, hostId) ? vector[hostId] : 0);
    params.push(hostId, Number.isFinite(acknowledged) ? Math.max(0, Math.floor(acknowledged)) : 0);
    return '(origin_host_id = ? AND origin_seq > ?)';
  });
  params.push(Math.max(1, Math.min(1_000, Math.floor(limit) || 250)));

  return all<ReplicationOperationRow>(
    `${REPLICATION_OPERATION_SELECT}
     WHERE ${conditions.join(' OR ')}
     ORDER BY ${CANONICAL_ORDER}
     LIMIT ?`,
    params
  ).map(operationFromRow);
}

export function getAllReplicationOperations(): ReplicationOperation[] {
  return all<ReplicationOperationRow>(`${REPLICATION_OPERATION_SELECT} ORDER BY ${CANONICAL_ORDER}`).map(
    operationFromRow
  );
}

export function getReplicationOperation(id: string): ReplicationOperation | null {
  const row = one<ReplicationOperationRow>(`${REPLICATION_OPERATION_SELECT} WHERE id = ?`, [id]);
  return row ? operationFromRow(row) : null;
}

export function getOpenReplicationConflictCount(): number {
  return one<{ count: number }>(`SELECT COUNT(*) AS count FROM replication_conflicts WHERE status = 'open'`)?.count ?? 0;
}

export function getReplicationConflicts(status: ReplicationConflict['status'] | 'all' = 'open'): ReplicationConflict[] {
  const rows = all<Omit<ReplicationConflict, 'operationIds' | 'operations'> & { operationIdsJson: string }>(
    `SELECT
       id,
       kind,
       operation_ids_json AS operationIdsJson,
       status,
       resolution_operation_id AS resolutionOperationId,
       created_at AS createdAt,
       resolved_at AS resolvedAt
     FROM replication_conflicts
     ${status === 'all' ? '' : 'WHERE status = ?'}
     ORDER BY created_at DESC`,
    status === 'all' ? [] : [status]
  );
  return rows.map(({ operationIdsJson, ...conflict }) => {
    const operationIds = JSON.parse(operationIdsJson) as string[];
    return {
      id: conflict.id,
      kind: conflict.kind,
      operationIds,
      status: conflict.status,
      resolutionOperationId: conflict.resolutionOperationId,
      createdAt: conflict.createdAt,
      resolvedAt: conflict.resolvedAt,
      operations: operationIds.flatMap((operationId) => {
        const operation = one<ReplicationConflict['operations'][number]>(
          `SELECT id, origin_host_id AS originHostId, type, created_at AS createdAt
           FROM replication_operations WHERE id = ?`,
          [operationId]
        );
        return operation ? [operation] : [];
      }),
    };
  });
}

function openConflictOperationIds(conflictId: string): string[] | null {
  const row = one<{ operationIdsJson: string }>(
    `SELECT operation_ids_json AS operationIdsJson FROM replication_conflicts WHERE id = ? AND status = 'open'`,
    [conflictId]
  );
  return row ? (JSON.parse(row.operationIdsJson) as string[]) : null;
}

/** Rebuilds the application tables with the chosen timing history winning the conflict. */
export function prepareReplicationConflictChoice(conflictId: string, selectedOperationId: string): void {
  const operationIds = openConflictOperationIds(conflictId);
  if (!operationIds) throw new Error('syncconflict niet gevonden of al opgelost');
  if (!operationIds.includes(selectedOperationId)) {
    throw new Error('de gekozen timingversie hoort niet bij dit conflict');
  }
  rebuildApplicationFromReplicationLog(new Set([selectedOperationId]));
}

/**
 * Records the resolved state as a full snapshot inside the resolving command,
 * so every peer converges on it regardless of its own replay order.
 */
export function finalizeReplicationConflict(
  conflictId: string,
  snapshot: AppSnapshot
): { conflictId: string; kept: 'current' } {
  if (!openConflictOperationIds(conflictId)) throw new Error('syncconflict niet gevonden of al opgelost');
  applySnapshot(snapshot);
  runUncaptured(`UPDATE replication_conflicts SET status = 'resolved', resolved_at = ? WHERE id = ?`, [
    Date.now(),
    conflictId,
  ]);
  return { conflictId, kept: 'current' };
}

/** Local operations not yet acknowledged by every known peer. */
export function getPendingReplicationOperationCount(): number {
  const peers = one<{ count: number }>('SELECT COUNT(DISTINCT peer_host_id) AS count FROM replication_peer_progress')?.count;
  if (!peers) return 0;
  const local = ensureReplicationIdentity().hostId;
  const acknowledged =
    one<{ seq: number }>(
      `SELECT COALESCE(MIN(COALESCE(progress.acknowledged_seq, 0)), 0) AS seq
       FROM (
         SELECT DISTINCT peer_host_id
         FROM replication_peer_progress
       ) AS peers
       LEFT JOIN replication_peer_progress AS progress
         ON progress.peer_host_id = peers.peer_host_id
        AND progress.origin_host_id = ?`,
      [local]
    )?.seq ?? 0;
  return (
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM replication_operations
       WHERE origin_host_id = ? AND origin_seq > ?`,
      [local, acknowledged]
    )?.count ?? 0
  );
}

export function acknowledgeReplicationVector(peerHostId: string, vector: Record<string, number>): void {
  const now = Date.now();
  const upsert = getDb().prepare(
    `INSERT INTO replication_peer_progress (
       peer_host_id, origin_host_id, acknowledged_seq, updated_at
     ) VALUES (?, ?, ?, ?)
     ON CONFLICT(peer_host_id, origin_host_id) DO UPDATE SET
       acknowledged_seq = MAX(replication_peer_progress.acknowledged_seq, excluded.acknowledged_seq),
       updated_at = excluded.updated_at`
  );
  transaction(() => {
    for (const originHostId of new Set([peerHostId, ...Object.keys(vector)])) {
      const seq = Number(hasOwn(vector, originHostId) ? vector[originHostId] : 0);
      upsert.run(peerHostId, originHostId, Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : 0, now);
    }
  });
}

function insertReplicationOperation(operation: ReplicationOperation): void {
  runUncaptured(
    `INSERT INTO replication_operations (
      id, cluster_id, origin_host_id, origin_seq, hlc_wall_ms, hlc_counter,
      type, payload_json, statements_json, result_json, race_base_key,
      status, checksum, created_at, applied_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      operation.id,
      operation.clusterId,
      operation.originHostId,
      operation.originSeq,
      operation.hlcWallMs,
      operation.hlcCounter,
      operation.type,
      JSON.stringify(operation.payload),
      JSON.stringify(operation.statements),
      JSON.stringify(operation.result),
      operation.raceBaseKey,
      operation.status,
      operation.checksum,
      operation.createdAt,
      operation.appliedAt,
    ]
  );
}

type DeadLetterOperation = {
  id: string;
  originHostId: string | null;
  originSeq: number | null;
  type: string | null;
  reason: string;
  createdAt: number;
};

const DEAD_LETTER_SETTING_KEY = 'replication_dead_letters_json';
const MAX_DEAD_LETTERS = 200;

/**
 * Quarantine for operations that can never apply (malformed, checksum
 * mismatch, id collision). Without it the sender keeps offering the same batch
 * and the vector never advances. Stored in settings rather than a table so
 * older and newer builds can still pair.
 */
function getDeadLetterOperations(): DeadLetterOperation[] {
  try {
    const parsed: unknown = JSON.parse(getSetting(DEAD_LETTER_SETTING_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is DeadLetterOperation =>
        Boolean(entry) && typeof entry.id === 'string' && typeof entry.reason === 'string'
    );
  } catch {
    return [];
  }
}

export function getDeadLetterCount(): number {
  return getDeadLetterOperations().length;
}

function recordDeadLetterOperation(operation: unknown, error: unknown): void {
  const record = (operation ?? {}) as Partial<ReplicationOperation>;
  const id = typeof record.id === 'string' && record.id ? record.id.slice(0, 128) : '(onbekend)';
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  const entry: DeadLetterOperation = {
    id,
    originHostId: typeof record.originHostId === 'string' ? record.originHostId.slice(0, 128) : null,
    originSeq: Number.isSafeInteger(record.originSeq) ? record.originSeq! : null,
    type: typeof record.type === 'string' ? record.type.slice(0, 128) : null,
    reason,
    createdAt: Date.now(),
  };
  const retained = [entry, ...getDeadLetterOperations().filter((item) => item.id !== id)];
  setLocalSetting(DEAD_LETTER_SETTING_KEY, JSON.stringify(retained.slice(0, MAX_DEAD_LETTERS)));
  console.warn(`Replication operation quarantined (${id}): ${reason}`);
}

function saveReplicationConflict(kind: ReplicationConflict['kind'], operationIds: string[]): void {
  const sortedIds = operationIds.slice().sort();
  const id = crypto.createHash('sha256').update(sortedIds.join(':')).digest('hex');
  runUncaptured(
    `INSERT INTO replication_conflicts (
       id, kind, operation_ids_json, status, created_at
     ) VALUES (?, ?, ?, 'open', ?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       operation_ids_json = excluded.operation_ids_json`,
    [id, kind, JSON.stringify(sortedIds), Date.now()]
  );
}

function resolutionConflictId(operation: ReplicationOperation): string | null {
  if (operation.type !== 'cluster.resolveConflict') return null;
  if (!operation.payload || typeof operation.payload !== 'object') return null;
  // Older operations carried the conflict id at the top level of the payload.
  const payload = operation.payload as { conflictId?: unknown; input?: { conflictId?: unknown } };
  const id = payload.conflictId ?? payload.input?.conflictId;
  return typeof id === 'string' && id ? id : null;
}

function markConflictResolvedBy(operation: ReplicationOperation): void {
  const conflictId = resolutionConflictId(operation);
  if (!conflictId) return;
  const resolution = runUncaptured(
    `UPDATE replication_conflicts
     SET status = 'resolved',
         resolution_operation_id = ?,
         resolved_at = ?
     WHERE id = ?`,
    [operation.id, Date.now(), conflictId]
  );
  if (resolution.changes === 0) {
    console.warn(`Conflict resolution ${operation.id} did not find conflict ${conflictId}`);
  }
}

function applyStatements(operation: ReplicationOperation): void {
  for (const { sql, params } of operation.statements) runUncaptured(sql, params);
}

function compareReplicationOperations(a: ReplicationOperation, b: ReplicationOperation): number {
  return (
    a.hlcWallMs - b.hlcWallMs ||
    a.hlcCounter - b.hlcCounter ||
    a.originHostId.localeCompare(b.originHostId) ||
    a.originSeq - b.originSeq
  );
}

/**
 * Restores the checkpoint and replays every later operation in canonical
 * order. Timing operations that started from the same race state compete; the
 * first (or preferred) one wins and the others become a timing conflict.
 */
function rebuildApplicationFromReplicationLog(preferredOperationIds: ReadonlySet<string> = new Set()): void {
  const checkpoint = ensureReplicationCheckpoint();
  const operations = getAllReplicationOperations().filter(
    (operation) => operation.originSeq > (checkpoint.vector[operation.originHostId] || 0)
  );
  const raceGroups = new Map<string, ReplicationOperation[]>();
  for (const operation of operations) {
    if (!operation.raceBaseKey) continue;
    const group = raceGroups.get(operation.raceBaseKey);
    if (group) group.push(operation);
    else raceGroups.set(operation.raceBaseKey, [operation]);
  }
  const raceChoices = new Map<string, string>();
  for (const [raceBaseKey, group] of raceGroups) {
    const preferred = group.find((operation) => preferredOperationIds.has(operation.id));
    raceChoices.set(raceBaseKey, (preferred ?? group[0]).id);
  }

  transaction(() => {
    restoreReplicationCheckpoint(checkpoint);
    runUncaptured('DELETE FROM replication_conflicts WHERE resolution_operation_id IS NULL');

    for (const operation of operations) {
      let conflictKind: ReplicationConflict['kind'] | null = null;
      let conflictOperationIds = [operation.id];
      const raceChoice = operation.raceBaseKey ? raceChoices.get(operation.raceBaseKey) : null;
      if (raceChoice && raceChoice !== operation.id) {
        conflictKind = 'timing';
        conflictOperationIds = [raceChoice, operation.id];
      } else {
        try {
          transaction(() => applyStatements(operation));
        } catch {
          conflictKind = operation.raceBaseKey ? 'timing' : 'data';
        }
      }

      runUncaptured('UPDATE replication_operations SET status = ?, applied_at = ? WHERE id = ?', [
        conflictKind ? 'conflict' : 'accepted',
        Date.now(),
        operation.id,
      ]);
      if (conflictKind) saveReplicationConflict(conflictKind, conflictOperationIds);
      else markConflictResolvedBy(operation);
    }
    compactStoredLapLabels();
  });
  markAppDataChanged();
}

function assertValidReplicationOperation(operation: ReplicationOperation): void {
  const validText = (value: unknown, maxLength: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  if (
    !operation ||
    typeof operation !== 'object' ||
    !validText(operation.id, 128) ||
    !validText(operation.clusterId, 128) ||
    !validText(operation.originHostId, 128) ||
    !Number.isSafeInteger(operation.originSeq) ||
    operation.originSeq < 1 ||
    !Number.isSafeInteger(operation.hlcWallMs) ||
    operation.hlcWallMs < 0 ||
    !Number.isSafeInteger(operation.hlcCounter) ||
    operation.hlcCounter < 0 ||
    !validText(operation.type, 128) ||
    !Array.isArray(operation.statements) ||
    operation.statements.length > 100_000 ||
    (operation.raceBaseKey !== null && !validText(operation.raceBaseKey, 1_024)) ||
    !/^[0-9a-f]{64}$/i.test(operation.checksum) ||
    !Number.isSafeInteger(operation.createdAt) ||
    operation.createdAt < 0
  ) {
    throw new Error('invalid replication operation');
  }

  for (const item of operation.statements) {
    if (
      !item ||
      typeof item.sql !== 'string' ||
      item.sql.length === 0 ||
      item.sql.length > 100_000 ||
      !isReplicatedMutation(item.sql) ||
      !Array.isArray(item.params) ||
      item.params.length > 10_000 ||
      item.params.some(
        (value) =>
          value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))
      )
    ) {
      throw new Error(`invalid replicated statement for ${operation.id}`);
    }
  }
}

/**
 * Accepts a batch from a peer. Invalid operations are quarantined so valid
 * ones around them still apply; a sequence gap or too many origins rejects the
 * whole batch, since those can heal on their own or need an operator.
 */
export function applyRemoteReplicationOperations(
  operations: ReplicationOperation[]
): { applied: number; duplicates: number; conflicts: number; quarantined: number } {
  const identity = ensureReplicationIdentity();
  if (!Array.isArray(operations) || operations.length > 1_000) {
    throw new Error('invalid replication batch');
  }
  let duplicates = 0;
  let quarantined = 0;
  const accepted: ReplicationOperation[] = [];
  const previousLastRow = one<ReplicationOperationRow>(
    `${REPLICATION_OPERATION_SELECT}
     ORDER BY hlc_wall_ms DESC, hlc_counter DESC, origin_host_id DESC, origin_seq DESC
     LIMIT 1`
  );
  const previousLastOperation = previousLastRow ? operationFromRow(previousLastRow) : null;
  const seenRaceBases = new Set(
    all<{ raceBaseKey: string }>(
      `SELECT DISTINCT race_base_key AS raceBaseKey
       FROM replication_operations
       WHERE status = 'accepted' AND race_base_key IS NOT NULL`
    ).map((row) => row.raceBaseKey)
  );
  let requiresRebuild = false;
  const expectedVector = getReplicationVector();

  const quarantine = (operation: unknown, error: unknown) => {
    recordDeadLetterOperation(operation, error);
    quarantined += 1;
    const { originHostId, originSeq } = (operation ?? {}) as Partial<ReplicationOperation>;
    if (typeof originHostId === 'string' && Number.isSafeInteger(originSeq)) {
      expectedVector[originHostId] = Math.max(expectedVector[originHostId] ?? 0, originSeq!);
    }
  };

  for (const operation of operations.slice().sort(compareReplicationOperations)) {
    try {
      assertValidReplicationOperation(operation);
      if (operation.clusterId !== identity.clusterId) {
        throw new Error('replication cluster mismatch');
      }
    } catch (error) {
      quarantine(operation, error);
      continue;
    }
    const existing = getReplicationOperation(operation.id);
    if (existing) {
      if (existing.checksum === operation.checksum) duplicates += 1;
      else quarantine(operation, new Error(`replication operation id collision for ${operation.id}`));
      continue;
    }
    if (operation.checksum !== replicationChecksum(operation)) {
      quarantine(operation, new Error(`replication checksum mismatch for ${operation.id}`));
      continue;
    }
    const hasKnownOrigin = hasOwn(expectedVector, operation.originHostId);
    const knownSeq = hasKnownOrigin ? expectedVector[operation.originHostId] : 0;
    if (!hasKnownOrigin && Object.keys(expectedVector).length >= MAX_REPLICATION_ORIGINS) {
      throw new Error('replication origin limit exceeded');
    }
    if (operation.originSeq !== knownSeq + 1) {
      throw new Error(
        `replication gap for ${operation.originHostId}: expected ${knownSeq + 1}, received ${operation.originSeq}`
      );
    }
    expectedVector[operation.originHostId] = operation.originSeq;
    accepted.push(operation);
    if (previousLastOperation && compareReplicationOperations(operation, previousLastOperation) < 0) {
      requiresRebuild = true;
    }
    if (operation.raceBaseKey) {
      if (seenRaceBases.has(operation.raceBaseKey)) requiresRebuild = true;
      seenRaceBases.add(operation.raceBaseKey);
    }
  }

  if (accepted.length) {
    ensureReplicationCheckpoint();
    const insertAccepted = () => {
      for (const operation of accepted) {
        insertReplicationOperation({ ...operation, status: 'accepted', appliedAt: Date.now() });
        observeRemoteHlc(operation.hlcWallMs, operation.hlcCounter);
      }
    };
    const insertAndRebuild = () =>
      transaction(() => {
        insertAccepted();
        rebuildApplicationFromReplicationLog();
      });

    if (requiresRebuild) {
      insertAndRebuild();
    } else {
      // Operations that arrive in canonical order apply directly; anything
      // that fails to apply falls back to a full deterministic rebuild.
      try {
        transaction(() => {
          insertAccepted();
          for (const operation of accepted) {
            applyStatements(operation);
            markConflictResolvedBy(operation);
          }
        });
        markAppDataChanged();
      } catch {
        insertAndRebuild();
      }
    }
  }

  const conflicts = accepted.filter(
    (operation) =>
      one<{ status: string }>('SELECT status FROM replication_operations WHERE id = ?', [operation.id])?.status ===
      'conflict'
  ).length;
  return { applied: accepted.length - conflicts, duplicates, conflicts, quarantined };
}

/** Replaces this host's database with a creator laptop's, keeping a recovery copy first. */
export async function installReplicationBootstrap(input: {
  clusterId: string;
  clusterSecret: string;
  snapshot: AppSnapshot;
  checkpoint: ReplicationCheckpoint;
  operations: ReplicationOperation[];
  conflicts: ReplicationConflict[];
  timingControllerHostId: string | null;
}): Promise<{ backupPath: string }> {
  for (const operation of input.operations) {
    if (operation.clusterId !== input.clusterId) {
      throw new Error('bootstrap bevat wijzigingen uit een andere cluster');
    }
    if (operation.checksum !== replicationChecksum(operation)) {
      throw new Error(`bootstrap checksum klopt niet voor ${operation.id}`);
    }
  }

  const backupPath = path.join(DATA_DIR, `app.before-cluster-join-${Date.now()}-${uuidv4().slice(0, 8)}.sqlite`);
  await getDb().backup(backupPath);
  transaction(() => {
    runUncaptured('DELETE FROM replication_peer_progress');
    runUncaptured('DELETE FROM replication_conflicts');
    runUncaptured('DELETE FROM replication_operations');
    applySnapshot(input.snapshot);
    setLocalSetting('replication_cluster_id', input.clusterId);
    setLocalSetting('replication_cluster_secret', input.clusterSecret);
    storeReplicationCheckpoint(input.checkpoint);
    if (input.timingControllerHostId) setLocalSetting(TIMING_CONTROLLER_KEY, input.timingControllerHostId);
    else deleteLocalSetting(TIMING_CONTROLLER_KEY);
    for (const operation of input.operations) {
      insertReplicationOperation(operation);
    }
    for (const conflict of input.conflicts) {
      runUncaptured(
        `INSERT INTO replication_conflicts (
           id, kind, operation_ids_json, status, resolution_operation_id,
           created_at, resolved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          conflict.id,
          conflict.kind,
          JSON.stringify(conflict.operationIds),
          conflict.status,
          conflict.resolutionOperationId,
          conflict.createdAt,
          conflict.resolvedAt,
        ]
      );
    }
  });
  if (input.operations.length) rebuildApplicationFromReplicationLog();
  markAppDataChanged();
  return { backupPath };
}
