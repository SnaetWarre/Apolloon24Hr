import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { all } from './connection.js';
import { ensureHostId, ensureLocalSetting, getSetting, setLocalSetting } from './settings.js';
import { type ReplicationIdentity } from './types.js';

export function ensureReplicationIdentity(): ReplicationIdentity {
  return {
    hostId: ensureHostId(),
    clusterId: ensureLocalSetting('replication_cluster_id', () => process.env.CLUSTER_ID?.trim() || uuidv4()),
    clusterSecret: ensureLocalSetting(
      'replication_cluster_secret',
      () => process.env.CLUSTER_SECRET?.trim() || crypto.randomBytes(32).toString('hex')
    ),
  };
}

function storedHlc(): { wallMs: number; counter: number } {
  return {
    wallMs: Number(getSetting('replication_hlc_wall_ms') || 0),
    counter: Number(getSetting('replication_hlc_counter') || 0),
  };
}

function storeHlc(wallMs: number, counter: number): void {
  setLocalSetting('replication_hlc_wall_ms', String(wallMs));
  setLocalSetting('replication_hlc_counter', String(counter));
}

/** Hybrid logical clock tick for a local write. */
export function nextLocalHlc(): { wallMs: number; counter: number } {
  const stored = storedHlc();
  const wallMs = Math.max(Date.now(), stored.wallMs);
  const counter = wallMs === stored.wallMs ? stored.counter + 1 : 0;
  storeHlc(wallMs, counter);
  return { wallMs, counter };
}

/** Advances the hybrid logical clock past a received operation. */
export function observeRemoteHlc(wallMs: number, counter: number): void {
  const stored = storedHlc();
  const nextWall = Math.max(Date.now(), stored.wallMs, wallMs);
  let nextCounter = 0;
  if (nextWall === stored.wallMs && nextWall === wallMs) nextCounter = Math.max(stored.counter, counter) + 1;
  else if (nextWall === stored.wallMs) nextCounter = stored.counter + 1;
  else if (nextWall === wallMs) nextCounter = counter + 1;
  storeHlc(nextWall, nextCounter);
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
