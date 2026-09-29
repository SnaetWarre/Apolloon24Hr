import type { ClusterStatus } from '../types';

export type ReadinessLevel = 'ready' | 'warning' | 'blocked';

export type ReadinessCheck = {
  id: string;
  label: string;
  level: ReadinessLevel;
  detail: string;
};

const MAX_CLOCK_SKEW_MS = 2_000;

export function buildEventReadiness(cluster: ClusterStatus | null, now = Date.now()): ReadinessCheck[] {
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
  const backupStale = backupAge === null || backupAge > backup.intervalMs * 3;
  checks.push({
    id: 'backup',
    label: 'Herstelbackup',
    level: !backup.enabled || backup.lastError || backupStale ? 'blocked' : 'ready',
    detail: !backup.enabled
      ? 'Automatische backups zijn uitgeschakeld.'
      : backup.lastError
        ? `Laatste fout: ${backup.lastError}`
        : backupAge === null
          ? 'Er is nog geen gecontroleerde backup.'
          : backupStale
            ? 'De laatste backup is ouder dan drie backupintervallen.'
            : 'Er is een recente gecontroleerde backup.',
  });

  checks.push({
    id: 'disk-space',
    label: 'Opslagruimte',
    level: backup.diskLow ? 'blocked' : backup.diskFreeBytes === null ? 'warning' : 'ready',
    detail: backup.diskLow
      ? 'De vrije ruimte zit onder de veiligheidsgrens.'
      : backup.diskFreeBytes === null
        ? 'Vrije opslagruimte kon niet worden gemeten.'
        : 'Er is voldoende vrije ruimte voor nieuwe backups.',
  });

  if (!cluster.enabled) {
    checks.push({
      id: 'replica',
      label: 'Tweede laptop',
      level: 'warning',
      detail: 'Deze installatie draait bewust zelfstandig; er is geen live tweede kopie.',
    });
    return checks;
  }

  checks.push(cluster.role === 'primary' ? standbyCheck(cluster) : primaryCheck(cluster));

  if (cluster.competingPrimaryUrl) {
    checks.push({
      id: 'competing-primary',
      label: 'Eén primaire laptop',
      level: 'blocked',
      detail: `${cluster.competingPrimaryUrl} is ook primair. Koppel één van beide opnieuw als standby.`,
    });
  }
  if (cluster.lastError) {
    checks.push({
      id: 'cluster-error',
      label: 'Synchronisatie',
      level: 'blocked',
      detail: cluster.lastError,
    });
  }

  const skew = cluster.clockSkewMs === null ? null : Math.abs(cluster.clockSkewMs);
  checks.push({
    id: 'clock',
    label: 'Systeemklokken',
    level: skew !== null && skew > MAX_CLOCK_SKEW_MS ? 'blocked' : 'ready',
    detail:
      skew === null
        ? 'Nog geen tweede laptop om mee te vergelijken.'
        : skew > MAX_CLOCK_SKEW_MS
          ? `De laptops verschillen ${Math.round(skew / 1_000)} seconden; na een overname kloppen rondetijden dan niet.`
          : 'De laptops liggen binnen twee seconden.',
  });
  return checks;
}

function standbyCheck(cluster: ClusterStatus): ReadinessCheck {
  const reachable = cluster.standbys.filter((standby) => standby.reachable);
  const caughtUp = reachable.some((standby) => standby.caughtUp);
  return {
    id: 'replica',
    label: 'Standby-laptop',
    level: caughtUp ? 'ready' : reachable.length ? 'warning' : 'blocked',
    detail: caughtUp
      ? `${reachable.length === 1 ? 'Een standby volgt' : `${reachable.length} standby's volgen`} deze laptop en ${reachable.length === 1 ? 'is' : 'zijn'} bij.`
      : reachable.length
        ? 'De standby werkt de laatste wijzigingen bij.'
        : 'Geen bereikbare standby-laptop. Koppel een tweede laptop in Beheer › Systeem.',
  };
}

function primaryCheck(cluster: ClusterStatus): ReadinessCheck {
  const primary = cluster.primary;
  return {
    id: 'replica',
    label: 'Primaire laptop',
    level: !primary?.reachable ? 'blocked' : primary.lagEntries > 0 ? 'warning' : 'ready',
    detail: !primary?.reachable
      ? `De primaire laptop${primary?.url ? ` (${primary.url})` : ''} is niet bereikbaar. Neem over in Beheer als die gestopt is.`
      : primary.lagEntries > 0
        ? `Deze standby haalt nog ${primary.lagEntries} wijziging${primary.lagEntries === 1 ? '' : 'en'} op.`
        : `Deze laptop is standby van ${primary.url} en is volledig bij.`,
  };
}

export function readinessSummary(checks: ReadinessCheck[]): ReadinessLevel {
  if (checks.some((check) => check.level === 'blocked')) return 'blocked';
  if (checks.some((check) => check.level === 'warning')) return 'warning';
  return 'ready';
}
