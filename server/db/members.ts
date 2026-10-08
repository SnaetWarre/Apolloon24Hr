import { all, run } from './connection.js';
import { clusterNow } from '../clock.js';

/**
 * The laptops in the group, kept in the replicated database so every laptop
 * agrees on who votes and how many make a majority. An empty table means a
 * laptop on its own. A laptop's computer name lives in a table of its own, so
 * the screens can name a laptop that is switched off.
 */
export type ClusterMember = { hostId: string; url: string; name?: string | null };

export function getClusterMembers(): ClusterMember[] {
  return all<ClusterMember>(
    `SELECT m.host_id AS hostId, m.url, n.name FROM cluster_members m
     LEFT JOIN cluster_member_names n ON n.host_id = m.host_id
     ORDER BY m.added_at, m.host_id`
  );
}

/** Adds a laptop or records its new address or name; a replicated write. Without a name, the stored one stays. */
export function saveClusterMember(member: ClusterMember): void {
  run(
    `INSERT INTO cluster_members (host_id, url, added_at) VALUES (?, ?, ?)
     ON CONFLICT(host_id) DO UPDATE SET url = excluded.url`,
    [member.hostId, member.url, clusterNow()]
  );
  if (member.name) {
    run('INSERT OR REPLACE INTO cluster_member_names (host_id, name) VALUES (?, ?)', [member.hostId, member.name]);
  }
}

/** Takes a laptop out of the group; a replicated write. */
export function removeClusterMember(hostId: string): void {
  run('DELETE FROM cluster_members WHERE host_id = ?', [hostId]);
  run('DELETE FROM cluster_member_names WHERE host_id = ?', [hostId]);
}

/** Leaves only this laptop in the group; a replicated write. */
export function keepOnlyClusterMember(hostId: string): void {
  run('DELETE FROM cluster_members WHERE host_id <> ?', [hostId]);
  run('DELETE FROM cluster_member_names WHERE host_id <> ?', [hostId]);
}
