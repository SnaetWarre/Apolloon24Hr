export type SqlValue = string | number | null;

export type ReplicatedStatement = {
  sql: string;
  params: SqlValue[];
};

/** One write on the leader, replayed in `seq` order by the other laptops. */
export type ReplicationLogEntry = {
  seq: number;
  id: string;
  epoch: number;
  type: string;
  statements: ReplicatedStatement[];
  createdAt: number;
};
