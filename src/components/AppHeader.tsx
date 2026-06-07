import React from 'react';
import { useAppData } from '../app';
import { useAppStore } from '../store';
import { RunnerActivationModal, RunnerAddModal } from './RunnerEntryModals';

export const AppHeader: React.FC<{ onOpenProfile?: (runnerId: string) => void }> = ({
  onOpenProfile,
}) => {
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const { host } = useAppData();
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
        {host && <div className="header-hint">{host.url}</div>}
      </div>
      {activationOpen && (
        <RunnerActivationModal onClose={() => setActivationOpen(false)} onOpenProfile={onOpenProfile} />
      )}
      {addOpen && <RunnerAddModal onClose={() => setAddOpen(false)} />}
    </>
  );
};
