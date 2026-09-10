import React from 'react';
import { useAppData, useClusterStatus } from '../app/index';
import { useAppStore } from '../store';
import { RunnerActivationModal, RunnerAddModal } from './RunnerEntryModals';
import type { ClusterStatus, LiveAppSnapshot } from '../types';

const selectHostData = ({ host }: LiveAppSnapshot) => ({ host });

export const AppHeader: React.FC<{ onOpenProfile?: (runnerId: string) => void }> = ({
  onOpenProfile,
}) => {
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const { host } = useAppData(selectHostData);
  const { cluster, error: clusterError } = useClusterStatus();
  const [activationOpen, setActivationOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const backupOverdue = Boolean(
    cluster?.backup.enabled &&
      (!cluster.backup.latest ||
        Date.now() - cluster.backup.latest.createdAt > cluster.backup.intervalMs * 3)
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
  const systemStatus = buildSystemStatus({
    cluster,
    error: clusterError,
    backupOverdue,
    backupUnhealthy,
    hasSynchronizedReplica,
    replicationDegraded,
  });

  return (
    <>
      <div className="header-bar">
        <div className="queue-controls">
          <button onClick={() => setActivationOpen(true)} className="btn btn--primary">
            Loper zoeken
          </button>
          <button onClick={() => setAddOpen(true)} className="btn btn--ghost">
            Nieuwe loper
          </button>
          <label className="board-search">
            <span>Filter dit bord</span>
            <input
              type="search"
              placeholder="Naam, nummer of label"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="input input--search input--stretch"
            />
          </label>
          {search && (
            <button className="btn btn--ghost" onClick={() => setSearch('')}>
              Filter wissen
            </button>
          )}
        </div>
        <div className="workspace-status">
          {systemStatus && (
            <div
              className={`cluster-pill cluster-pill--${systemStatus.tone}`}
              role={systemStatus.tone === 'error' ? 'alert' : 'status'}
              aria-live="polite"
              aria-atomic="true"
            >
              <strong>{systemStatus.title}</strong>
              <span>{systemStatus.detail}</span>
            </div>
          )}
          {host && <div className="header-hint">{host.url}</div>}
        </div>
      </div>
      {activationOpen && (
        <RunnerActivationModal
          onClose={() => setActivationOpen(false)}
          onOpenProfile={onOpenProfile}
          onActivated={() => setSearch('')}
        />
      )}
      {addOpen && <RunnerAddModal onClose={() => setAddOpen(false)} onAdded={() => setSearch('')} />}
    </>
  );
};

function buildSystemStatus(input: {
  cluster: ClusterStatus | null;
  error: Error | null;
  backupOverdue: boolean;
  backupUnhealthy: boolean;
  hasSynchronizedReplica: boolean;
  replicationDegraded: boolean;
}): { tone: 'healthy' | 'standby' | 'error'; title: string; detail: string } | null {
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
      detail: 'Timing is gepauzeerd tot het conflict in Admin is opgelost',
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
