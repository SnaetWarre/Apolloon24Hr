import { v4 as uuidv4 } from 'uuid';
import crypto from 'node:crypto';
import { type ReplicationIdentity } from './types.js';
import { ensureHostId, getSetting, setReplicationSetting } from './settings.js';
import { all } from './connection.js';

export function ensureReplicationIdentity(): ReplicationIdentity {
  const hostId = ensureHostId();
  let clusterId = getSetting('replication_cluster_id');
  let clusterSecret = getSetting('replication_cluster_secret');
  if (!clusterId) {
    const generatedClusterId = process.env.CLUSTER_ID?.trim() || uuidv4();
    setReplicationSetting('replication_cluster_id', generatedClusterId);
    clusterId = generatedClusterId;
  }
  if (!clusterSecret) {
    const generatedClusterSecret =
      process.env.CLUSTER_SECRET?.trim() || crypto.randomBytes(32).toString('hex');
    setReplicationSetting('replication_cluster_secret', generatedClusterSecret);
    clusterSecret = generatedClusterSecret;
  }
  return { clusterId: clusterId!, clusterSecret: clusterSecret!, hostId };
}

export function nextLocalHlc(): { wallMs: number; counter: number } {
  const storedWall = Number(getSetting('replication_hlc_wall_ms') || 0);
  const storedCounter = Number(getSetting('replication_hlc_counter') || 0);
  const now = Date.now();
  const wallMs = Math.max(now, storedWall);
  const counter = wallMs === storedWall ? storedCounter + 1 : 0;
  setReplicationSetting('replication_hlc_wall_ms', String(wallMs));
  setReplicationSetting('replication_hlc_counter', String(counter));
  return { wallMs, counter };
}

export function observeRemoteHlc(wallMs: number, counter: number): void {
  const storedWall = Number(getSetting('replication_hlc_wall_ms') || 0);
  const storedCounter = Number(getSetting('replication_hlc_counter') || 0);
  const now = Date.now();
  const nextWall = Math.max(now, storedWall, wallMs);
  const nextCounter =
    nextWall === storedWall && nextWall === wallMs
      ? Math.max(storedCounter, counter) + 1
      : nextWall === storedWall
        ? storedCounter + 1
        : nextWall === wallMs
          ? counter + 1
          : 0;
  setReplicationSetting('replication_hlc_wall_ms', String(nextWall));
  setReplicationSetting('replication_hlc_counter', String(nextCounter));
}

export function getReplicationVector(): Record<string, number> {
  return Object.fromEntries(
    all<{ hostId: string; seq: number }>(
      `SELECT origin_host_id AS hostId, MAX(origin_seq) AS seq
       FROM replication_operations
       GROUP BY origin_host_id`
    ).map((row) => [row.hostId, row.seq])
  );
}
