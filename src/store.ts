import React from 'react';

interface UiState {
  search: string;
  setSearch: (q: string) => void;
}

let currentSearch = '';
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSearchSnapshot(): string {
  return currentSearch;
}

function setSearch(q: string): void {
  if (currentSearch === q) return;
  currentSearch = q;
  listeners.forEach((listener) => listener());
}

const stableState: UiState = {
  get search() {
    return currentSearch;
  },
  setSearch,
};

export function useAppStore<T>(selector: (state: UiState) => T): T {
  const search = React.useSyncExternalStore(subscribe, getSearchSnapshot, getSearchSnapshot);
  return React.useMemo(
    () => selector({ search, setSearch }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, selector],
  );
}

export { stableState as appStore };
