import React from 'react';
import { useAppStore } from '../store';
import { Icon } from './Icon';
import { RunnerActivationModal, RunnerAddModal } from './RunnerEntryModals';

/** Queue page actions: filter the board, add a new runner, or check a runner in. */
export const AppHeader: React.FC<{ onOpenProfile?: (runnerId: string) => void }> = ({
  onOpenProfile,
}) => {
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const [activationOpen, setActivationOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const filterRef = React.useRef<HTMLInputElement>(null);

  return (
    <>
      <div className={`board-search${search ? ' is-filtering' : ''}`}>
        <Icon name="search" size={15} />
        <input
          ref={filterRef}
          type="search"
          aria-label="Filter dit bord"
          placeholder="Filter bord"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search && (
          <button
            type="button"
            className="board-search__clear"
            onClick={() => {
              setSearch('');
              filterRef.current?.focus();
            }}
            aria-label="Filter wissen"
            title="Filter wissen"
          >
            <Icon name="close" size={14} />
          </button>
        )}
      </div>
      <button onClick={() => setAddOpen(true)} className="btn">
        Nieuwe loper
      </button>
      <button onClick={() => setActivationOpen(true)} className="btn btn--primary">
        Loper zoeken
      </button>
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
