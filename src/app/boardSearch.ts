import React from 'react';

/** The queue board filter, shared by the page header input and the board. */
let boardSearch = '';
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setBoardSearch(value: string): void {
  if (boardSearch === value) return;
  boardSearch = value;
  listeners.forEach((listener) => listener());
}

export function useBoardSearch(): string {
  return React.useSyncExternalStore(subscribe, () => boardSearch);
}
