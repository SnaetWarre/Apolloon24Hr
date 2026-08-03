import type { ClusterStatus, RaceState } from '../types';

export type ReadinessLevel = 'ready' | 'warning' | 'blocked';

export type ReadinessCheck = {
  id: string;
  label: string;
  level: ReadinessLevel;
  detail: string;
};

export function buildEventReadiness(
  cluster: ClusterStatus | null,
  race: RaceState,
  now = Date.now()
): ReadinessCheck[] {
  if (!cluster) {
    return [
      {
        id: 'server-status',
        label: 'Serverstatus',
        level: 'blocked',
        detail: 'De serverstatus kon niet worden geladen.',
      },
    ];
  }

  const checks: ReadinessCheck[] = [];
  const backup = cluster.backup;
  const backupAge = backup.latest ? Math.max(0, now - backup.latest.createdAt) : null;
  const backupMaxAge = backup.intervalMs * 3;
  checks.push({
    id: 'backup',
    label: 'Herstelbackup',
    level:
      !backup.enabled || backup.lastError || backupAge === null || backupAge > backupMaxAge
        ? 'blocked'
        : 'ready',
    detail: !backup.enabled
      ? 'Automatische backups zijn uitgeschakeld.'
      : backup.lastError
        ? `Laatste fout: ${backup.lastError}`
        : backupAge === null
          ? 'Er is nog geen geverifieerde backup.'
          : backupAge > backupMaxAge
            ? 'De laatste backup is ouder dan drie backupintervallen.'
            : 'Er is een recente geverifieerde backup.',
  });

  checks.push({
    id: 'disk-space',
    label: 'Opslagruimte',
    level: backup.diskLow ? 'blocked' : backup.diskFreeBytes === null ? 'warning' : 'ready',
    detail: backup.diskLow
      ? 'De vrije ruimte zit onder de ingestelde veiligheidsgrens.'
      : backup.diskFreeBytes === null
        ? 'Vrije opslagruimte kon niet worden gemeten.'
        : 'Er is voldoende vrije ruimte voor nieuwe backups.',
  });

  checks.push({
    id: 'database-size',
    label: 'Databasegrootte',
    level: backup.database.compactionRecommended ? 'warning' : 'ready',
    detail: backup.database.compactionRecommended
      ? `${Math.round(backup.database.reclaimablePercent)}% van het databasebestand is herbruikbare ruimte; verklein het na de race in Admin.`
      : 'Het databasebestand bevat geen overmatige vrije ruimte.',
  });

  if (cluster.enabled) {
    checks.push({
      id: 'compatibility',
      label: 'Laptopversies',
      level: cluster.incompatiblePeerCount > 0 ? 'blocked' : 'ready',
      detail:
        cluster.incompatiblePeerCount > 0
          ? `${cluster.incompatiblePeerCount} laptop${cluster.incompatiblePeerCount === 1 ? '' : 's'} moet eerst worden bijgewerkt; synchronisatie is veilig geblokkeerd.`
          : `Schema ${cluster.compatibility.schemaVersion}, replicatieformaat ${cluster.compatibility.replicationFormatVersion} en app ${cluster.compatibility.appVersion} zijn compatibel.`,
    });
    const synchronizedPeer = cluster.peers.some(
      (peer) => peer.reachable && peer.synchronized
    );
    checks.push({
      id: 'replica',
      label: 'Live replica',
      level: synchronizedPeer && cluster.pendingOperations === 0 ? 'ready' : 'blocked',
      detail: !synchronizedPeer
        ? 'Geen bereikbare, volledig gesynchroniseerde tweede laptop.'
        : cluster.pendingOperations > 0
          ? `${cluster.pendingOperations} wijziging${cluster.pendingOperations === 1 ? '' : 'en'} wacht op synchronisatie.`
          : 'Minstens één tweede laptop is volledig gesynchroniseerd.',
    });
    checks.push({
      id: 'clock',
      label: 'Systeemklokken',
      level: (cluster.clockSkewMs ?? 0) > 2_000 ? 'blocked' : 'ready',
      detail:
        (cluster.clockSkewMs ?? 0) > 2_000
          ? `Het gemeten verschil is ${Math.round((cluster.clockSkewMs ?? 0) / 1_000)} seconden.`
          : 'De bereikbare laptops liggen binnen twee seconden.',
    });
  } else {
    checks.push({
      id: 'replica',
      label: 'Live replica',
      level: 'warning',
      detail: 'Deze installatie draait bewust zelfstandig; er is geen live tweede kopie.',
    });
  }

  checks.push({
    id: 'conflicts',
    label: 'Synchronisatieconflicten',
    level: cluster.conflictCount > 0 ? 'blocked' : 'ready',
    detail:
      cluster.conflictCount > 0
        ? `${cluster.conflictCount} conflict${cluster.conflictCount === 1 ? '' : 'en'} moet nog worden opgelost.`
        : 'Er zijn geen open conflicten.',
  });

  const timing = cluster.timingControl;
  checks.push({
    id: 'timing-controller',
    label: 'Timingcontroller',
    level:
      timing.state === 'remote-unreachable'
        ? 'blocked'
        : timing.state === 'unassigned'
          ? race.raceStartedAt
            ? 'blocked'
            : 'warning'
          : 'ready',
    detail:
      timing.state === 'local'
        ? 'Deze laptop bedient de timing.'
        : timing.state === 'remote-reachable'
          ? 'De toegewezen timinglaptop is bereikbaar.'
          : timing.state === 'remote-unreachable'
            ? 'De toegewezen timinglaptop is niet bereikbaar.'
            : race.raceStartedAt
              ? 'De race is gestart maar timing is niet toegewezen.'
              : 'Timing wordt bij de eerste timingactie toegewezen.',
  });

  return checks;
}

export function readinessSummary(checks: ReadinessCheck[]): ReadinessLevel {
  if (checks.some((check) => check.level === 'blocked')) return 'blocked';
  if (checks.some((check) => check.level === 'warning')) return 'warning';
  return 'ready';
}
