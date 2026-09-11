import { ensureReplicationIdentity, nextLocalHlc, getReplicationVector, observeRemoteHlc } from './replication-state.js';
import { getSetting, setSetting, setReplicationSetting } from './settings.js';
import crypto from 'node:crypto';
import { type ReplicationOperation, type ReplicatedSqlStatement, type SqlValue, type ReplicationConflict, type ReplicationCheckpoint } from './types.js';
import { v4 as uuidv4 } from 'uuid';
import { one, isCapturingWrite, transaction, captureWrite, getDb, all, markAppDataChanged, isReplicatedMutation, DATA_DIR } from './connection.js';
import { ensureReplicationCheckpoint, restoreReplicationCheckpoint, compactStoredLapLabels, storeReplicationCheckpoint } from './checkpoint.js';
import { type AppSnapshot } from '../../shared/schemas.js';
import { applySnapshot } from './snapshot.js';
import path from 'path';

const MAX_REPLICATION_ORIGINS = 64;

export function assertOrClaimTimingController(): string {
  if (getOpenReplicationConflictCount() > 0) {
    throw new Error(
      'Timing is gepauzeerd door een syncconflict. Los dit eerst op in Admin.'
    );
  }
  const hostId = ensureReplicationIdentity().hostId;
  const current = getSetting('timing_controller_host_id');
  if (current && current !== hostId) {
    throw new Error('De timing wordt bediend op een andere laptop');
  }
  assignTimingController(hostId);
  return hostId;
}

export function claimTimingController(): string {
  const hostId = ensureReplicationIdentity().hostId;
  assignTimingController(hostId);
  return hostId;
}

export function assignTimingController(hostId: string): {
  hostId: string;
  generation: number;
} {
  const targetHostId = String(hostId || '').trim();
  if (!targetHostId || targetHostId.length > 128) {
    throw new Error('ongeldige timinglaptop');
  }
  const current = getSetting('timing_controller_host_id');
  const storedGeneration = Number(getSetting('timing_controller_generation') || 0);
  if (current === targetHostId && storedGeneration > 0) {
    return { hostId: targetHostId, generation: storedGeneration };
  }
  const generation = Math.max(0, Math.floor(storedGeneration) || 0) + 1;
  setSetting('timing_controller_host_id', targetHostId);
  setSetting('timing_controller_generation', String(generation));
  return { hostId: targetHostId, generation };
}

export function getTimingControllerGeneration(): number {
  const generation = Number(getSetting('timing_controller_generation') || 0);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

function replicationChecksum(input: Omit<ReplicationOperation, 'checksum' | 'status' | 'appliedAt'>): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        id: input.id,
        clusterId: input.clusterId,
        originHostId: input.originHostId,
        originSeq: input.originSeq,
        hlcWallMs: input.hlcWallMs,
        hlcCounter: input.hlcCounter,
        type: input.type,
        payload: input.payload,
        statements: input.statements,
        result: input.result,
        raceBaseKey: input.raceBaseKey,
        createdAt: input.createdAt,
      })
    )
    .digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue) => {
    if (
      nestedValue &&
      typeof nestedValue === 'object' &&
      !Array.isArray(nestedValue)
    ) {
      return Object.fromEntries(
        Object.entries(nestedValue as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b)
        )
      );
    }
    return nestedValue;
  });
}

function hasOwn(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function replicationOperationFromRow(row: {
  id: string;
  clusterId: string;
  originHostId: string;
  originSeq: number;
  hlcWallMs: number;
  hlcCounter: number;
  type: string;
  payloadJson: string;
  statementsJson: string;
  resultJson: string;
  raceBaseKey: string | null;
  status: ReplicationOperation['status'];
  checksum: string;
  createdAt: number;
  appliedAt: number;
}): ReplicationOperation {
  return {
    id: row.id,
    clusterId: row.clusterId,
    originHostId: row.originHostId,
    originSeq: row.originSeq,
    hlcWallMs: row.hlcWallMs,
    hlcCounter: row.hlcCounter,
    type: row.type,
    payload: JSON.parse(row.payloadJson) as unknown,
    statements: JSON.parse(row.statementsJson) as ReplicatedSqlStatement[],
    result: JSON.parse(row.resultJson) as unknown,
    raceBaseKey: row.raceBaseKey,
    status: row.status,
    checksum: row.checksum,
    createdAt: row.createdAt,
    appliedAt: row.appliedAt,
  };
}

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

export function commitReplicatedWrite<T>(input: {
  id?: string;
  type: string;
  payload?: unknown;
  raceBaseKey?: string | null;
  action: () => T;
}): T {
  const identity = ensureReplicationIdentity();
  const id = input.id || uuidv4();
  const existing = one<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT} WHERE id = ?`,
    [id]
  );
  if (existing) {
    const operation = replicationOperationFromRow(existing);
    if (
      operation.type !== input.type ||
      stableJson(operation.payload) !== stableJson(input.payload ?? null)
    ) {
      throw new Error('command id was already used for a different write');
    }
    return operation.result as T;
  }
  if (isCapturingWrite()) throw new Error('nested replicated write is not supported');

  return transaction(() => {
    ensureReplicationCheckpoint();
    const originSeq =
      (one<{ seq: number }>(
        `SELECT COALESCE(MAX(origin_seq), 0) AS seq
         FROM replication_operations
         WHERE origin_host_id = ?`,
        [identity.hostId]
      )?.seq ?? 0) + 1;
    const hlc = nextLocalHlc();
    const { result, statements } = captureWrite(input.action);
    const createdAt = Date.now();
    const base = {
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
      createdAt,
    };
    const checksum = replicationChecksum(base);
    getDb()
      .prepare(
        `INSERT INTO replication_operations (
          id, cluster_id, origin_host_id, origin_seq, hlc_wall_ms, hlc_counter,
          type, payload_json, statements_json, result_json, race_base_key,
          status, checksum, created_at, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`
      )
      .run(
        id,
        identity.clusterId,
        identity.hostId,
        originSeq,
        hlc.wallMs,
        hlc.counter,
        input.type,
        JSON.stringify(base.payload),
        JSON.stringify(statements),
        JSON.stringify(base.result),
        base.raceBaseKey,
        checksum,
        createdAt,
        createdAt
      );
    return result;
  });
}

export function getReplicationOperationsMissing(
  vector: Record<string, number>,
  limit = 250
): ReplicationOperation[] {
  const origins = all<{ hostId: string }>(
    `SELECT DISTINCT origin_host_id AS hostId
     FROM replication_operations`
  );
  if (!origins.length) return [];

  const params: SqlValue[] = [];
  const conditions = origins.map(({ hostId }) => {
    const acknowledged = Number(
      hasOwn(vector, hostId) ? vector[hostId] : 0
    );
    params.push(
      hostId,
      Number.isFinite(acknowledged) ? Math.max(0, Math.floor(acknowledged)) : 0
    );
    return '(origin_host_id = ? AND origin_seq > ?)';
  });
  params.push(Math.max(1, Math.min(1_000, Math.floor(limit) || 250)));

  return all<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT}
     WHERE ${conditions.join(' OR ')}
     ORDER BY hlc_wall_ms, hlc_counter, origin_host_id, origin_seq
     LIMIT ?`,
    params
  )
    .map(replicationOperationFromRow);
}

export function getAllReplicationOperations(): ReplicationOperation[] {
  return all<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT}
     ORDER BY hlc_wall_ms, hlc_counter, origin_host_id, origin_seq`
  ).map(replicationOperationFromRow);
}

export function getReplicationOperation(id: string): ReplicationOperation | null {
  const row = one<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT} WHERE id = ?`,
    [id]
  );
  return row ? replicationOperationFromRow(row) : null;
}

export function getOpenReplicationConflictCount(): number {
  return (
    one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM replication_conflicts WHERE status = 'open'`
    )?.count ?? 0
  );
}

export function getReplicationConflicts(
  status: ReplicationConflict['status'] | 'all' = 'open'
): ReplicationConflict[] {
  const where = status === 'all' ? '' : 'WHERE status = ?';
  const params: SqlValue[] = status === 'all' ? [] : [status];
  return all<{
    id: string;
    kind: ReplicationConflict['kind'];
    operationIdsJson: string;
    status: ReplicationConflict['status'];
    resolutionOperationId: string | null;
    createdAt: number;
    resolvedAt: number | null;
  }>(
    `SELECT
       id,
       kind,
       operation_ids_json AS operationIdsJson,
       status,
       resolution_operation_id AS resolutionOperationId,
       created_at AS createdAt,
       resolved_at AS resolvedAt
     FROM replication_conflicts
     ${where}
     ORDER BY created_at DESC`,
    params
  ).map((row) => ({
    id: row.id,
    kind: row.kind,
    operationIds: JSON.parse(row.operationIdsJson) as string[],
    status: row.status,
    resolutionOperationId: row.resolutionOperationId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
  })).map((conflict) => ({
    ...conflict,
    operations: conflict.operationIds.flatMap((id) => {
      const operation = getReplicationOperation(id);
      return operation
        ? [{
            id: operation.id,
            originHostId: operation.originHostId,
            type: operation.type,
            createdAt: operation.createdAt,
          }]
        : [];
    }),
  }));
}

export function prepareReplicationConflictChoice(
  conflictId: string,
  selectedOperationId: string
): void {
  const conflict = getReplicationConflicts().find((item) => item.id === conflictId);
  if (!conflict) throw new Error('syncconflict niet gevonden of al opgelost');
  if (!conflict.operationIds.includes(selectedOperationId)) {
    throw new Error('de gekozen timingversie hoort niet bij dit conflict');
  }
  rebuildApplicationFromReplicationLog(new Set([selectedOperationId]));
}

export function finalizeReplicationConflict(
  conflictId: string,
  snapshot: AppSnapshot
): { conflictId: string; kept: 'current' } {
  const conflict = one<{ id: string }>(
    `SELECT id FROM replication_conflicts
     WHERE id = ? AND status = 'open'`,
    [conflictId]
  );
  if (!conflict) throw new Error('syncconflict niet gevonden of al opgelost');
  applySnapshot(snapshot);
  getDb()
    .prepare(
      `UPDATE replication_conflicts
       SET status = 'resolved', resolved_at = ?
       WHERE id = ?`
    )
    .run(Date.now(), conflictId);
  return { conflictId, kept: 'current' };
}

export function getPendingReplicationOperationCount(): number {
  const peers =
    one<{ count: number }>(
      'SELECT COUNT(DISTINCT peer_host_id) AS count FROM replication_peer_progress'
    )?.count ?? 0;
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

export function acknowledgeReplicationVector(
  peerHostId: string,
  vector: Record<string, number>
): void {
  const now = Date.now();
  const origins = new Set([peerHostId, ...Object.keys(vector)]);
  transaction(() => {
    for (const originHostId of origins) {
      const seq = Number(
        hasOwn(vector, originHostId) ? vector[originHostId] : 0
      );
      getDb()
        .prepare(
          `INSERT INTO replication_peer_progress (
             peer_host_id, origin_host_id, acknowledged_seq, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(peer_host_id, origin_host_id) DO UPDATE SET
             acknowledged_seq = MAX(replication_peer_progress.acknowledged_seq, excluded.acknowledged_seq),
             updated_at = excluded.updated_at`
        )
        .run(
          peerHostId,
          originHostId,
          Number.isFinite(seq) ? Math.max(0, Math.floor(seq)) : 0,
          now
        );
    }
  });
}

function insertReplicationOperation(operation: ReplicationOperation): void {
  getDb()
    .prepare(
      `INSERT INTO replication_operations (
        id, cluster_id, origin_host_id, origin_seq, hlc_wall_ms, hlc_counter,
        type, payload_json, statements_json, result_json, race_base_key,
        status, checksum, created_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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
      operation.appliedAt
    );
}

function operationConflictId(operationIds: string[]): string {
  return crypto
    .createHash('sha256')
    .update(operationIds.slice().sort().join(':'))
    .digest('hex');
}

function saveReplicationConflict(
  kind: ReplicationConflict['kind'],
  operationIds: string[]
): string {
  const sortedIds = operationIds.slice().sort();
  const id = operationConflictId(sortedIds);
  getDb()
    .prepare(
      `INSERT INTO replication_conflicts (
         id, kind, operation_ids_json, status, created_at
       ) VALUES (?, ?, ?, 'open', ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         operation_ids_json = excluded.operation_ids_json`
    )
    .run(id, kind, JSON.stringify(sortedIds), Date.now());
  return id;
}

function resolutionConflictId(operation: ReplicationOperation): string | null {
  if (operation.type !== 'cluster.resolveConflict') return null;
  if (!operation.payload || typeof operation.payload !== 'object') return null;
  const payload = operation.payload as {
    conflictId?: unknown;
    input?: { conflictId?: unknown };
  };
  const id = payload.conflictId ?? payload.input?.conflictId;
  return typeof id === 'string' && id ? id : null;
}

function compareReplicationOperations(
  a: ReplicationOperation,
  b: ReplicationOperation
): number {
  return (
    a.hlcWallMs - b.hlcWallMs ||
    a.hlcCounter - b.hlcCounter ||
    a.originHostId.localeCompare(b.originHostId) ||
    a.originSeq - b.originSeq
  );
}

function rebuildApplicationFromReplicationLog(
  preferredOperationIds: ReadonlySet<string> = new Set()
): void {
  const checkpoint = ensureReplicationCheckpoint();
  const operations = all<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT}
     ORDER BY hlc_wall_ms, hlc_counter, origin_host_id, origin_seq`
  )
    .map(replicationOperationFromRow)
    .filter(
      (operation) =>
        operation.originSeq > (checkpoint.vector[operation.originHostId] || 0)
    );
  const raceGroups = new Map<string, ReplicationOperation[]>();
  for (const operation of operations) {
    if (!operation.raceBaseKey) continue;
    const group = raceGroups.get(operation.raceBaseKey) || [];
    group.push(operation);
    raceGroups.set(operation.raceBaseKey, group);
  }
  const raceChoices = new Map<string, string>();
  for (const [raceBaseKey, group] of raceGroups) {
    const preferred = group.find((operation) => preferredOperationIds.has(operation.id));
    raceChoices.set(raceBaseKey, (preferred || group[0]).id);
  }

  transaction(() => {
    restoreReplicationCheckpoint(checkpoint);
    getDb()
      .prepare(
        `DELETE FROM replication_conflicts
         WHERE resolution_operation_id IS NULL`
      )
      .run();

    for (const operation of operations) {
      let conflictKind: ReplicationConflict['kind'] | null = null;
      let conflictOperationIds = [operation.id];
      const raceChoice = operation.raceBaseKey
        ? raceChoices.get(operation.raceBaseKey)
        : null;
      if (raceChoice && raceChoice !== operation.id) {
        conflictKind = 'timing';
        conflictOperationIds = [raceChoice, operation.id];
      } else {
        try {
          getDb().transaction(() => {
            for (const item of operation.statements) {
              getDb().prepare(item.sql).run(...item.params);
            }
          })();
        } catch {
          conflictKind = operation.raceBaseKey ? 'timing' : 'data';
        }
      }

      const status: ReplicationOperation['status'] = conflictKind
        ? 'conflict'
        : 'accepted';
      getDb()
        .prepare(
          `UPDATE replication_operations
           SET status = ?, applied_at = ?
           WHERE id = ?`
        )
        .run(status, Date.now(), operation.id);

      if (conflictKind) {
        saveReplicationConflict(conflictKind, conflictOperationIds);
        continue;
      }
      const resolvedConflictId = resolutionConflictId(operation);
      if (resolvedConflictId) {
        const resolution = getDb()
          .prepare(
            `UPDATE replication_conflicts
             SET status = 'resolved',
                 resolution_operation_id = ?,
                 resolved_at = ?
             WHERE id = ?`
          )
          .run(operation.id, Date.now(), resolvedConflictId);
        if (resolution.changes === 0) {
          console.warn(
            `Conflict resolution ${operation.id} did not find conflict ${resolvedConflictId}`
          );
        }
      }
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
    (operation.raceBaseKey !== null &&
      !validText(operation.raceBaseKey, 1_024)) ||
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
          value !== null &&
          typeof value !== 'string' &&
          (typeof value !== 'number' || !Number.isFinite(value))
      )
    ) {
      throw new Error(`invalid replicated statement for ${operation.id}`);
    }
  }
}

export function applyRemoteReplicationOperations(
  operations: ReplicationOperation[]
): { applied: number; duplicates: number; conflicts: number } {
  const identity = ensureReplicationIdentity();
  if (!Array.isArray(operations) || operations.length > 1_000) {
    throw new Error('invalid replication batch');
  }
  let duplicates = 0;
  const insertedIds: string[] = [];
  const insertedOperations: ReplicationOperation[] = [];
  const previousLastRow = one<Parameters<typeof replicationOperationFromRow>[0]>(
    `${REPLICATION_OPERATION_SELECT}
     ORDER BY hlc_wall_ms DESC, hlc_counter DESC, origin_host_id DESC, origin_seq DESC
     LIMIT 1`
  );
  const previousLastOperation = previousLastRow
    ? replicationOperationFromRow(previousLastRow)
    : null;
  const seenRaceBases = new Set(
    all<{ raceBaseKey: string }>(
      `SELECT DISTINCT race_base_key AS raceBaseKey
       FROM replication_operations
       WHERE status = 'accepted' AND race_base_key IS NOT NULL`
    ).map((row) => row.raceBaseKey)
  );
  let requiresRebuild = false;
  const ordered = operations.slice().sort(compareReplicationOperations);
  const expectedVector = getReplicationVector();

  for (const operation of ordered) {
    assertValidReplicationOperation(operation);
    if (operation.clusterId !== identity.clusterId) {
      throw new Error('replication cluster mismatch');
    }
    const existing = getReplicationOperation(operation.id);
    if (existing) {
      if (existing.checksum !== operation.checksum) {
        throw new Error(`replication operation id collision for ${operation.id}`);
      }
      duplicates += 1;
      continue;
    }
    const expectedChecksum = replicationChecksum({
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
    });
    if (operation.checksum !== expectedChecksum) {
      throw new Error(`replication checksum mismatch for ${operation.id}`);
    }
    const hasKnownOrigin = hasOwn(
      expectedVector,
      operation.originHostId
    );
    const knownSeq = hasKnownOrigin
      ? expectedVector[operation.originHostId]
      : 0;
    if (
      knownSeq === 0 &&
      !hasKnownOrigin &&
      Object.keys(expectedVector).length >= MAX_REPLICATION_ORIGINS
    ) {
      throw new Error('replication origin limit exceeded');
    }
    if (operation.originSeq !== knownSeq + 1) {
      throw new Error(
        `replication gap for ${operation.originHostId}: expected ${knownSeq + 1}, received ${operation.originSeq}`
      );
    }
    expectedVector[operation.originHostId] = operation.originSeq;
    insertedIds.push(operation.id);
    insertedOperations.push(operation);
    if (
      previousLastOperation &&
      compareReplicationOperations(operation, previousLastOperation) < 0
    ) {
      requiresRebuild = true;
    }
    if (operation.raceBaseKey) {
      if (seenRaceBases.has(operation.raceBaseKey)) requiresRebuild = true;
      seenRaceBases.add(operation.raceBaseKey);
    }
  }
  if (insertedIds.length) {
    ensureReplicationCheckpoint();
    const insertOperations = () => {
      for (const operation of insertedOperations) {
        insertReplicationOperation({
          ...operation,
          status: 'accepted',
          appliedAt: Date.now(),
        });
        observeRemoteHlc(operation.hlcWallMs, operation.hlcCounter);
      }
    };

    if (requiresRebuild) {
      transaction(() => {
        insertOperations();
        rebuildApplicationFromReplicationLog();
      });
    } else {
      try {
        transaction(() => {
          insertOperations();
          for (const operation of insertedOperations) {
            for (const item of operation.statements) {
              getDb().prepare(item.sql).run(...item.params);
            }
            const resolvedConflictId = resolutionConflictId(operation);
            if (resolvedConflictId) {
              getDb()
                .prepare(
                  `UPDATE replication_conflicts
                   SET status = 'resolved',
                       resolution_operation_id = ?,
                       resolved_at = ?
                   WHERE id = ?`
                )
                .run(operation.id, Date.now(), resolvedConflictId);
            }
          }
        });
        markAppDataChanged();
      } catch {
        transaction(() => {
          insertOperations();
          rebuildApplicationFromReplicationLog();
        });
      }
    }
  }
  const conflicts = insertedIds.filter(
    (id) => getReplicationOperation(id)?.status === 'conflict'
  ).length;
  const applied = insertedIds.length - conflicts;
  return { applied, duplicates, conflicts };
}

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
    const expectedChecksum = replicationChecksum({
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
    });
    if (operation.checksum !== expectedChecksum) {
      throw new Error(`bootstrap checksum klopt niet voor ${operation.id}`);
    }
  }

  const backupPath = path.join(
    DATA_DIR,
    `app.before-cluster-join-${Date.now()}-${uuidv4().slice(0, 8)}.sqlite`
  );
  await getDb().backup(backupPath);
  transaction(() => {
    getDb().prepare('DELETE FROM replication_peer_progress').run();
    getDb().prepare('DELETE FROM replication_conflicts').run();
    getDb().prepare('DELETE FROM replication_operations').run();
    applySnapshot(input.snapshot);
    setReplicationSetting('replication_cluster_id', input.clusterId);
    setReplicationSetting('replication_cluster_secret', input.clusterSecret);
    storeReplicationCheckpoint(input.checkpoint);
    if (input.timingControllerHostId) {
      setReplicationSetting(
        'timing_controller_host_id',
        input.timingControllerHostId
      );
    } else {
      getDb()
        .prepare("DELETE FROM settings WHERE key = 'timing_controller_host_id'")
        .run();
    }
    for (const operation of input.operations) {
      insertReplicationOperation(operation);
    }
    for (const conflict of input.conflicts) {
      getDb()
        .prepare(
          `INSERT INTO replication_conflicts (
             id, kind, operation_ids_json, status, resolution_operation_id,
             created_at, resolved_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          conflict.id,
          conflict.kind,
          JSON.stringify(conflict.operationIds),
          conflict.status,
          conflict.resolutionOperationId,
          conflict.createdAt,
          conflict.resolvedAt
        );
    }
  });
  if (input.operations.length) rebuildApplicationFromReplicationLog();
  markAppDataChanged();
  return { backupPath };
}
