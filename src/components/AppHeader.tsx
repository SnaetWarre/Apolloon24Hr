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
          <div className={`cluster-pill cluster-pill--${cluster.writable ? 'leader' : 'standby'}`}>
            <strong>{cluster.writable ? 'Primary' : 'Standby'}</strong>
            <span>
              seq {cluster.lastAppliedSeq}
              {!cluster.writable && cluster.leaderUrl ? ` · leader ${cluster.leaderUrl}` : ''}
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
