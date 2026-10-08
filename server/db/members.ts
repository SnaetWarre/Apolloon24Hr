import { z } from 'zod';
import { all, run } from './connection.js';
import { getSetting } from './settings.js';
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
  setUnreachableMembers([]);
}

/**
 * The laptops Beheer › Activiteit last listed as unreachable; a replicated setting, so a
 * laptop that takes over goes on from the same list instead of listing them again.
 */
export function getUnreachableMembers(): string[] {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(getSetting('cluster_unreachable_json') || '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function setUnreachableMembers(hostIds: string[]): void {
  run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [
    'cluster_unreachable_json',
    JSON.stringify(hostIds),
  ]);
}

const REMOVED_KEPT = 16;

/**
 * The laptops the crew took out of the group with "Uit de groep halen", newest first; a
 * replicated setting. Such a laptop is not taken back in when it asks for votes again;
 * only Koppelen on that laptop brings it back.
 */
export function getRemovedMembers(): string[] {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(getSetting('cluster_removed_json') || '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function setRemovedMembers(hostIds: string[]): void {
  run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [
    'cluster_removed_json',
    JSON.stringify(hostIds.slice(0, REMOVED_KEPT)),
  ]);
}

/** A laptop that linked with the group by itself, and the laptop it linked with. */
export type AutoLink = { hostId: string; with: string; at: number };

const AUTO_LINKS_KEPT = 16;
const autoLinksSchema = z.array(z.object({ hostId: z.string(), with: z.string(), at: z.number() }));

/** The laptops that linked by themselves, newest first; a replicated setting, so every laptop of the group can say so. */
export function getAutoLinks(): AutoLink[] {
  try {
    const parsed = autoLinksSchema.safeParse(JSON.parse(getSetting('cluster_auto_links_json') || '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Records that `hostId` linked by itself with the laptop named `with`; part of the write that adds it. */
export function saveAutoLink(hostId: string, linkedWith: string): void {
  const links = [
    { hostId, with: linkedWith, at: clusterNow() },
    ...getAutoLinks().filter((link) => link.hostId !== hostId),
  ].slice(0, AUTO_LINKS_KEPT);
  run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', ['cluster_auto_links_json', JSON.stringify(links)]);
}
