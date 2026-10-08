import type { ClusterStatus } from '../types';

export type ReadinessLevel = 'ready' | 'warning' | 'blocked';

export type ReadinessCheck = {
  id: string;
  label: string;
  level: ReadinessLevel;
  detail: string;
};

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
      label: 'Gekoppelde laptops',
      level: 'warning',
      detail: 'Koppelen staat uit op deze installatie; de gegevens staan alleen op deze laptop.',
    });
    return checks;
  }

  checks.push(groupCheck(cluster));
  if (cluster.lastError) {
    checks.push({
      id: 'cluster-error',
      label: 'Laptops',
      level: 'warning',
      detail: cluster.lastError,
    });
  }

  return checks;
}

function groupCheck(cluster: ClusterStatus): ReadinessCheck {
  const total = cluster.members.length;
  const reachable = cluster.members.filter((member) => member.reachable).length;
  const offline = cluster.members.filter((member) => !member.reachable).map((member) => member.name);
  const check = (level: ReadinessLevel, detail: string): ReadinessCheck => ({
    id: 'replica',
    label: 'Gekoppelde laptops',
    level,
    detail,
  });
  switch (cluster.state) {
    case 'solo':
      return check(
        'blocked',
        'Deze laptop staat er alleen voor. Koppel de andere laptops in Beheer › Systeem, zodat een defecte laptop geen gegevens kost.'
      );
    case 'electing':
      return check('warning', 'De laptops kiezen wie de wijzigingen ordent. Dit duurt enkele seconden.');
    case 'no-majority':
      return check(
        'blocked',
        'Te weinig laptops bereikbaar: wijzigingen worden niet bewaard. Zet de andere laptops aan of controleer de netwerkkabel.'
      );
    case 'degraded':
      return check(
        'warning',
        reachable < total
          ? `${reachable} van de ${total} laptops zijn bereikbaar. Alles werkt nog; zet ${offline.every(Boolean) ? offline.join(' en ') : 'de andere laptop'} weer aan.`
          : 'Een laptop haalt de laatste wijzigingen op.'
      );
    case 'healthy':
      return total === 2
        ? check('warning', 'Twee laptops gekoppeld. Koppel een derde: met twee stopt het bewaren als er één uitvalt.')
        : check('ready', `Alle ${total} laptops zijn bereikbaar en hebben alle gegevens.`);
  }
}

export function readinessSummary(checks: ReadinessCheck[]): ReadinessLevel {
  if (checks.some((check) => check.level === 'blocked')) return 'blocked';
  if (checks.some((check) => check.level === 'warning')) return 'warning';
  return 'ready';
}
