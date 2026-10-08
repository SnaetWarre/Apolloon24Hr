import type { ClusterStatus } from '../types';

export type SystemStatusTone = 'healthy' | 'warning' | 'error';
export type SystemStatus = { tone: SystemStatusTone; title: string; detail: string };

/** The one-line laptop health summary shown in the sidebar and on the overview. */
export function deriveSystemStatus(
  cluster: ClusterStatus | null,
  error: Error | null,
  now = Date.now()
): SystemStatus | null {
  if (error) {
    return {
      tone: 'error',
      title: 'Serververbinding controleren',
      detail: 'De systeemstatus kon niet worden vernieuwd',
    };
  }
  if (!cluster) return null;

  if (cluster.enabled) {
    const group = describeGroup(cluster);
    if (group.tone !== 'healthy') return group;
  }
  if (cluster.lastError)
    return {
      tone: 'error',
      title: 'Laptops controleren',
      detail: cluster.lastError,
    };

  const backup = cluster.backup;
  const backupOverdue = backup.enabled && (!backup.latest || now - backup.latest.createdAt > backup.intervalMs * 3);
  if (!backup.enabled || backup.lastError || backup.diskLow || backupOverdue) {
    return {
      tone: backup.diskLow || backup.lastError ? 'error' : 'warning',
      title: 'Backup controleren',
      detail: backup.lastError
        ? 'Laatste backup is mislukt'
        : backup.diskLow
          ? 'Vrije opslag zit onder de veiligheidsgrens'
          : !backup.enabled
            ? 'Automatische backups zijn uitgeschakeld'
            : 'Geen recente herstelbackup',
    };
  }
  if (!cluster.enabled) {
    return {
      tone: 'healthy',
      title: 'Lokale opslag gezond',
      detail: backup.latest ? `Backup ${formatAge(backup.latest.createdAt, now)}` : 'Backupservice is actief',
    };
  }
  return describeGroup(cluster);
}

/** How the linked laptops are doing, in words for the people at the tables. */
export function describeGroup(cluster: ClusterStatus): SystemStatus {
  const total = cluster.members.length;
  const unreachable = cluster.members.filter((member) => !member.reachable).length;
  if (cluster.removedFrom) {
    return { tone: 'error', title: 'Uit de groep gehaald', detail: 'Niets wordt bewaard; koppel opnieuw in Beheer' };
  }
  switch (cluster.state) {
    case 'solo':
      return { tone: 'warning', title: 'Alleen deze laptop', detail: 'Koppel de andere laptops in Beheer' };
    case 'electing':
      return { tone: 'warning', title: 'Laptops nemen over', detail: 'Even geduld, dit duurt enkele seconden' };
    case 'no-majority':
      return {
        tone: 'error',
        title: 'Te weinig laptops bereikbaar',
        detail: 'Niets wordt bewaard; zet de andere laptops aan',
      };
    case 'degraded':
      return unreachable
        ? {
            tone: 'warning',
            title: unreachable === 1 ? 'Eén laptop onbereikbaar' : `${unreachable} laptops onbereikbaar`,
            detail: `Alles werkt nog; bewaard op ${total - unreachable} laptops`,
          }
        : { tone: 'warning', title: 'Laptop werkt bij', detail: 'De laatste wijzigingen worden gekopieerd' };
    case 'healthy':
      return total === 2
        ? { tone: 'warning', title: 'Twee laptops', detail: 'Koppel een derde, zodat er één mag uitvallen' }
        : { tone: 'healthy', title: 'Alles veilig', detail: `Gegevens op ${total} laptops` };
  }
}

/** Laptops of the group that linked by themselves, this laptop first, in words for Systeem and Overzicht. */
export function describeAutoLinks(cluster: ClusterStatus, now = Date.now()): Array<{ hostId: string; text: string }> {
  return [...cluster.autoLink.linked]
    .sort((a, b) => Number(b.self) - Number(a.self))
    .map((link) => ({
      hostId: link.hostId,
      text: link.self
        ? `Automatisch gekoppeld met ${link.with}, ${formatAge(link.at, now)}`
        : `${link.name} is automatisch bijgekomen, ${formatAge(link.at, now)}`,
    }));
}

function formatAge(createdAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
  if (minutes < 1) return 'minder dan een minuut geleden';
  if (minutes === 1) return '1 minuut geleden';
  if (minutes < 60) return `${minutes} minuten geleden`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 uur geleden' : `${hours} uur geleden`;
}
