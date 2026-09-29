import { all, run } from './connection.js';
import { clusterNow } from '../clock.js';

/**
 * The laptops in the group, kept in the replicated database so every laptop
 * agrees on who votes and how many make a majority. An empty table means a
 * laptop on its own.
 */
export type ClusterMember = { hostId: string; url: string };

export function getClusterMembers(): ClusterMember[] {
  return all<ClusterMember>('SELECT host_id AS hostId, url FROM cluster_members ORDER BY added_at, host_id');
}

/** Adds a laptop or records its new address; a replicated write. */
export function saveClusterMember(member: ClusterMember): void {
  run(
    `INSERT INTO cluster_members (host_id, url, added_at) VALUES (?, ?, ?)
     ON CONFLICT(host_id) DO UPDATE SET url = excluded.url`,
    [member.hostId, member.url, clusterNow()]
  );
}

/** Leaves only this laptop in the group; a replicated write. */
export function keepOnlyClusterMember(hostId: string): void {
  run('DELETE FROM cluster_members WHERE host_id <> ?', [hostId]);
}
