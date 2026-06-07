import type { QueryClient } from '@tanstack/react-query';
import type { AppSnapshot, RaceState } from '../types';

export const snapshotKey = ['app', 'snapshot'] as const;

export const emptyRace: RaceState = {
  id: 1,
  activeRunnerId: null,
  activeStartedAt: null,
  raceStartedAt: null,
  raceFinishedAt: null,
};

export function patchSnapshot(
  queryClientToPatch: QueryClient,
  updater: (snapshot: AppSnapshot) => AppSnapshot
): void {
  queryClientToPatch.setQueryData<AppSnapshot>(snapshotKey, (current) => {
    if (!current) return current;
    return updater(current);
  });
}

export function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex === -1) return [...items, nextItem];
  return items.map((item, index) => (index === existingIndex ? nextItem : item));
}
