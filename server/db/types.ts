export type SqlValue = string | number | null;

export type ReplicatedSqlStatement = {
  sql: string;
  params: SqlValue[];
};

export type ReplicationOperation = {
  id: string;
  clusterId: string;
  originHostId: string;
  originSeq: number;
  hlcWallMs: number;
  hlcCounter: number;
  type: string;
  payload: unknown;
  statements: ReplicatedSqlStatement[];
  result: unknown;
  raceBaseKey: string | null;
  status: 'accepted' | 'conflict' | 'rejected';
  checksum: string;
  createdAt: number;
  appliedAt: number;
};

export type ReplicationIdentity = {
  clusterId: string;
  clusterSecret: string;
  hostId: string;
};

export type ReplicationConflict = {
  id: string;
  kind: 'timing' | 'data';
  operationIds: string[];
  status: 'open' | 'resolved';
  resolutionOperationId: string | null;
  createdAt: number;
  resolvedAt: number | null;
  operations: Array<{
    id: string;
    originHostId: string;
    type: string;
    createdAt: number;
  }>;
};

export type ReplicationCheckpoint = {
  vector: Record<string, number>;
  tables: Record<string, Array<Record<string, SqlValue>>>;
  settings: Record<string, string>;
};
