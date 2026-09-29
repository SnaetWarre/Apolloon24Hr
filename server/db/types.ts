export type SqlValue = string | number | null;

export type ReplicatedStatement = {
  sql: string;
  params: SqlValue[];
};

/** One committed write on the primary, replayed in `seq` order by standbys. */
export type ReplicationLogEntry = {
  seq: number;
  id: string;
  epoch: number;
  type: string;
  statements: ReplicatedStatement[];
  createdAt: number;
};
