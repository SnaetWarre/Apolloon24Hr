import React from 'react';
import { useAppStore } from '../store';
import { RunnerActivationModal, RunnerAddModal } from './RunnerEntryModals';

/** Queue toolbar: check a runner in, add a new one, or filter the board. */
export const AppHeader: React.FC<{ onOpenProfile?: (runnerId: string) => void }> = ({
  onOpenProfile,
}) => {
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const [activationOpen, setActivationOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);

  return (
    <>
      <div className="queue-toolbar">
        <button onClick={() => setActivationOpen(true)} className="btn btn--primary">
          Loper zoeken
        </button>
        <button onClick={() => setAddOpen(true)} className="btn">
          Nieuwe loper
        </button>
        <label className="board-search">
          <span className="visually-hidden">Filter dit bord</span>
          <input
            type="search"
            placeholder="Filter op naam, nummer of label"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={`input${search ? ' is-filtering' : ''}`}
          />
        </label>
        <button
          className="btn btn--quiet"
          onClick={() => setSearch('')}
          disabled={!search}
          title={search ? 'Filter wissen' : 'Geen filter actief'}
        >
          Filter wissen
        </button>
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
