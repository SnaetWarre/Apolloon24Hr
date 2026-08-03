import React from 'react';
import { useAppData, useClusterStatus } from '../app/index';
import { useAppStore } from '../store';
import { RunnerActivationModal, RunnerAddModal } from './RunnerEntryModals';
import type { AppSnapshot } from '../types';

const selectHostData = ({ host }: AppSnapshot) => ({ host });

export const AppHeader: React.FC<{ onOpenProfile?: (runnerId: string) => void }> = ({
  onOpenProfile,
}) => {
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const { host } = useAppData(selectHostData);
  const { cluster } = useClusterStatus();
  const [activationOpen, setActivationOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const backupOverdue = Boolean(
    cluster?.backup.enabled &&
      (!cluster.backup.latest ||
        Date.now() - cluster.backup.latest.createdAt > cluster.backup.intervalMs * 3)
  );
  const backupUnhealthy = Boolean(
    cluster && (!cluster.backup.enabled || cluster.backup.lastError || backupOverdue)
  );
  const hasSynchronizedReplica = Boolean(
    cluster?.peers.some((peer) => peer.reachable && peer.synchronized)
  );
  const replicationDegraded = Boolean(
    cluster?.enabled && (!hasSynchronizedReplica || cluster.pendingOperations > 0)
  );

  return (
    <>
      <div className="header-bar">
        <button onClick={() => setActivationOpen(true)} className="btn btn--primary">
          Loper zoeken
        </button>
        <button onClick={() => setAddOpen(true)} className="btn btn--ghost">
          Nieuwe loper
        </button>
        <input
          placeholder="Filter bord op naam, nummer of label..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="input input--search input--stretch"
        />
        {cluster?.enabled && (
          <div
            className={`cluster-pill cluster-pill--${
              cluster.conflictCount > 0
                ? 'standby'
                : (cluster.clockSkewMs ?? 0) > 2_000
                  ? 'standby'
                : backupUnhealthy || replicationDegraded
                  ? 'standby'
                  : 'healthy'
            }`}
          >
            <strong>
              {cluster.conflictCount > 0
                ? 'Synchronisatieconflict'
                : (cluster.clockSkewMs ?? 0) > 2_000
                  ? 'Klokken verschillen'
                : backupUnhealthy
                  ? 'Backup controleren'
                : cluster.connectedHosts === 1
                  ? '1 lokale replica'
                  : `Op ${cluster.connectedHosts} laptops`}
            </strong>
            <span>
              {cluster.pendingOperations > 0
                ? `${cluster.pendingOperations} wijziging${cluster.pendingOperations === 1 ? '' : 'en'} wacht op synchronisatie`
                : (cluster.clockSkewMs ?? 0) > 2_000
                  ? `Controleer systeemtijd (${Math.round((cluster.clockSkewMs ?? 0) / 1_000)} s verschil)`
                : cluster.backup.lastError
                  ? 'Laatste backup is mislukt'
                  : !cluster.backup.enabled
                    ? 'Automatische backups zijn uitgeschakeld'
                  : backupOverdue
                    ? 'Geen recente herstelbackup'
                    : cluster.connectedHosts === 1
                      ? 'Geen live replica bereikbaar'
                      : !hasSynchronizedReplica
                        ? 'Synchronisatie met replica bezig'
                      : 'Gesynchroniseerd en geback-upt'}
            </span>
          </div>
        )}
        {host && <div className="header-hint">{host.url}</div>}
      </div>
      {activationOpen && (
        <RunnerActivationModal onClose={() => setActivationOpen(false)} onOpenProfile={onOpenProfile} />
      )}
      {addOpen && <RunnerAddModal onClose={() => setAddOpen(false)} />}
    </>
  );
};
