import type { ClusterStatus } from '../types';

export type SystemStatusTone = 'healthy' | 'standby' | 'error';
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

  if (cluster.competingPrimaryUrl) {
    return {
      tone: 'error',
      title: 'Twee primaire laptops',
      detail: `Ook ${cluster.competingPrimaryUrl} is primair`,
    };
  }
  if (cluster.role === 'standby') {
    const primary = cluster.primary;
    if (!primary?.reachable) {
      return {
        tone: 'error',
        title: 'Primaire laptop onbereikbaar',
        detail: 'Deze standby is alleen-lezen; neem over in Beheer',
      };
    }
    return {
      tone: 'standby',
      title: 'Standby (alleen-lezen)',
      detail: primary.lagEntries > 0 ? `Haalt ${primary.lagEntries} wijzigingen op` : `Volgt ${primary.url}`,
    };
  }
  if (cluster.lastError)
    return {
      tone: 'error',
      title: 'Synchronisatie controleren',
      detail: cluster.lastError,
    };
  if ((cluster.clockSkewMs ?? 0) > 2_000) {
    return {
      tone: 'standby',
      title: 'Klokken verschillen',
      detail: `Controleer de systeemtijd (${Math.round((cluster.clockSkewMs ?? 0) / 1_000)} s verschil)`,
    };
  }

  const backup = cluster.backup;
  const backupOverdue = backup.enabled && (!backup.latest || now - backup.latest.createdAt > backup.intervalMs * 3);
  if (!backup.enabled || backup.lastError || backup.diskLow || backupOverdue) {
    return {
      tone: backup.diskLow || backup.lastError ? 'error' : 'standby',
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
  const followers = cluster.standbys.filter((standby) => standby.reachable);
  if (!followers.length)
    return {
      tone: 'standby',
      title: 'Geen standby',
      detail: 'Alleen deze laptop heeft de data',
    };
  if (!followers.some((standby) => standby.caughtUp)) {
    return {
      tone: 'standby',
      title: 'Standby werkt bij',
      detail: 'De laatste wijzigingen worden gekopieerd',
    };
  }
  return {
    tone: 'healthy',
    title: `Primair · ${followers.length} standby`,
    detail: 'Gekopieerd en geback-upt',
  };
}

function formatAge(createdAt: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
  if (minutes < 1) return 'minder dan een minuut geleden';
  if (minutes === 1) return '1 minuut geleden';
  if (minutes < 60) return `${minutes} minuten geleden`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 uur geleden' : `${hours} uur geleden`;
}
