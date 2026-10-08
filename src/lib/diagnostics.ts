import type { DesktopDiagnostics } from './desktop';
import { describeGroup } from './systemStatus';
import type { ClusterStatus, HostInfo } from '../types';

/**
 * The text "Diagnose kopiëren" puts on the clipboard: enough for someone helping from a
 * distance to see what this laptop runs and how the group and backups are doing.
 */
export function buildDiagnosticsText({
  cluster,
  host,
  desktop,
  userAgent,
  now = Date.now(),
}: {
  cluster: ClusterStatus | null;
  host: HostInfo | null;
  desktop: DesktopDiagnostics | null;
  userAgent: string;
  now?: number;
}): string {
  const lines = [`Apolloon Telsysteem — diagnose van ${new Date(now).toLocaleString('nl-BE')}`, ''];
  const version = desktop?.appVersion ?? cluster?.appVersion;
  lines.push(`Versie: ${version ?? 'onbekend'}${cluster ? ` · schema ${cluster.schemaVersion}` : ''}`);
  if (desktop) {
    lines.push(`Scherm: desktop-app (Electron ${desktop.electron}, Chrome ${desktop.chrome})`);
    lines.push(`Besturingssysteem: ${desktop.os}`);
    lines.push(`Gegevensmap: ${desktop.dataPath}`);
  } else {
    lines.push(`Scherm: browser (${userAgent})`);
  }
  if (host) lines.push(`Adres: ${host.url}`);

  if (cluster) {
    lines.push('');
    if (cluster.enabled) {
      const group = describeGroup(cluster);
      lines.push(`Groep: ${group.title} — ${group.detail}`);
      lines.push(
        `Rol: ${cluster.role} · term ${cluster.term} · log ${cluster.logHead} · ${cluster.writable ? 'kan bewaren' : 'kan niet bewaren'}`
      );
      for (const member of cluster.members) {
        const state = [
          member.self && 'deze laptop',
          member.leader && 'leider',
          member.reachable ? 'bereikbaar' : 'niet bereikbaar',
          member.caughtUp && 'heeft alles',
        ]
          .filter(Boolean)
          .join(', ');
        lines.push(`  ${member.name ? `${member.name} ` : ''}${member.url} (${state})`);
      }
      for (const found of cluster.nearby) {
        lines.push(
          `  gevonden: ${found.name ? `${found.name} ` : ''}${found.url} (versie ${found.appVersion}${found.compatible ? '' : ', niet compatibel'})`
        );
      }
    } else {
      lines.push('Groep: koppelen staat uit op deze installatie');
    }
    if (cluster.lastError) lines.push(`Laatste fout: ${cluster.lastError}`);
    const backup = cluster.backup;
    lines.push(
      `Backup: ${backup.latest ? `laatste ${new Date(backup.latest.createdAt).toLocaleString('nl-BE')}` : 'nog geen'}` +
        `${backup.lastError ? ` · mislukt: ${backup.lastError}` : ''}` +
        ` · vrij ${backup.diskFreeBytes === null ? 'onbekend' : `${Math.round(backup.diskFreeBytes / 1024 / 1024)} MB`}`
    );
  }

  if (desktop?.logTail) {
    lines.push('', '--- laatste regels van server.log ---', desktop.logTail);
  }
  return lines.join('\n');
}
