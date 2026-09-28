import React from 'react';
import { setBoardSearch, useBoardSearch } from '../app/boardSearch';
import { Icon } from './Icon';
import { RunnerActivationModal, RunnerAddModal } from './RunnerEntryModals';

/** Queue page actions: filter the board, add a new runner, or check a runner in. */
export function QueueActions({ onOpenProfile }: { onOpenProfile?: (runnerId: string) => void }) {
  const search = useBoardSearch();
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
          onChange={(event) => setBoardSearch(event.target.value)}
        />
        {search && (
          <button
            type="button"
            className="board-search__clear"
            onClick={() => {
              setBoardSearch('');
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
          onActivated={() => setBoardSearch('')}
        />
      )}
      {addOpen && <RunnerAddModal onClose={() => setAddOpen(false)} onAdded={() => setBoardSearch('')} />}
    </>
  );
}
