import type { ClusterStatus } from '../types';

export type SystemStatusTone = 'healthy' | 'standby' | 'error';
export type SystemStatus = { tone: SystemStatusTone; title: string; detail: string };

/** Derives the one-line laptop health summary shown in the operator top bar. */
export function deriveSystemStatus(
  cluster: ClusterStatus | null,
  error: Error | null,
  now = Date.now()
): SystemStatus | null {
  const backupOverdue = Boolean(
    cluster?.backup.enabled &&
      (!cluster.backup.latest ||
        now - cluster.backup.latest.createdAt > cluster.backup.intervalMs * 3)
  );
  const backupUnhealthy = Boolean(
    cluster &&
      (!cluster.backup.enabled ||
        cluster.backup.lastError ||
        cluster.backup.diskLow ||
        backupOverdue)
  );
  const hasSynchronizedReplica = Boolean(
    cluster?.peers.some((peer) => peer.reachable && peer.synchronized)
  );
  const replicationDegraded = Boolean(
    cluster?.enabled && (!hasSynchronizedReplica || cluster.pendingOperations > 0)
  );
  return buildSystemStatus({
    cluster,
    error,
    backupOverdue,
    backupUnhealthy,
    hasSynchronizedReplica,
    replicationDegraded,
  });
}

function buildSystemStatus(input: {
  cluster: ClusterStatus | null;
  error: Error | null;
  backupOverdue: boolean;
  backupUnhealthy: boolean;
  hasSynchronizedReplica: boolean;
  replicationDegraded: boolean;
}): SystemStatus | null {
  const { cluster, error } = input;
  if (error) {
    return {
      tone: 'error',
      title: 'Serververbinding controleren',
      detail: 'De actuele systeemstatus kon niet worden vernieuwd',
    };
  }
  if (!cluster) return null;
  if (cluster.incompatiblePeerCount > 0) {
    return {
      tone: 'error',
      title: 'Laptopupdate vereist',
      detail: `${cluster.incompatiblePeerCount} laptop${cluster.incompatiblePeerCount === 1 ? '' : 's'} gebruikt een incompatibele Apolloon-versie`,
    };
  }
  if (cluster.conflictCount > 0) {
    return {
      tone: 'error',
      title: 'Synchronisatieconflict',
      detail: 'Timing is gepauzeerd tot het conflict in Beheer is opgelost',
    };
  }
  if ((cluster.clockSkewMs ?? 0) > 2_000) {
    return {
      tone: 'standby',
      title: 'Klokken verschillen',
      detail: `Controleer systeemtijd (${Math.round((cluster.clockSkewMs ?? 0) / 1_000)} s verschil)`,
    };
  }
  if (input.backupUnhealthy) {
    return {
      tone: cluster.backup.diskLow || cluster.backup.lastError ? 'error' : 'standby',
      title: 'Backup controleren',
      detail: cluster.backup.lastError
        ? 'Laatste backup is mislukt'
        : cluster.backup.diskLow
          ? 'Vrije opslag zit onder de veiligheidsgrens'
          : !cluster.backup.enabled
            ? 'Automatische backups zijn uitgeschakeld'
            : input.backupOverdue
              ? 'Geen recente herstelbackup'
              : 'Backupstatus vraagt aandacht',
    };
  }
  if (cluster.enabled && input.replicationDegraded) {
    return {
      tone: 'standby',
      title: cluster.connectedHosts === 1 ? '1 lokale replica' : 'Synchronisatie bezig',
      detail:
        cluster.pendingOperations > 0
          ? `${cluster.pendingOperations} wijziging${cluster.pendingOperations === 1 ? '' : 'en'} wacht op synchronisatie`
          : input.hasSynchronizedReplica
            ? 'Replica werkt de laatste wijzigingen bij'
            : 'Geen volledig gesynchroniseerde replica bereikbaar',
    };
  }
  if (!cluster.enabled) {
    return {
      tone: 'healthy',
      title: 'Lokale opslag gezond',
      detail: cluster.backup.latest
        ? `Backup ${formatAge(cluster.backup.latest.createdAt)}`
        : 'Backupservice is actief',
    };
  }
  return {
    tone: 'healthy',
    title: `Op ${cluster.connectedHosts} laptops`,
    detail: 'Gesynchroniseerd en geback-upt',
  };
}

function formatAge(createdAt: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60_000));
  if (minutes < 1) return 'minder dan een minuut geleden';
  if (minutes === 1) return '1 minuut geleden';
  if (minutes < 60) return `${minutes} minuten geleden`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 uur geleden' : `${hours} uur geleden`;
}
