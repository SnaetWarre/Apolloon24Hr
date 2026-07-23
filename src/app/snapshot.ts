import type { QueryClient } from '@tanstack/react-query';
import type { AppSettings, AppSnapshot, RaceState } from '../types';

export const snapshotKey = ['app', 'snapshot'] as const;

export const emptyRace: RaceState = {
  id: 1,
  activeRunnerId: null,
  activeStartedAt: null,
  raceStartedAt: null,
  raceFinishedAt: null,
  activeLabels: [],
};

export const defaultSettings: AppSettings = {
  publicRecordMode: 'day',
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
  if (items[existingIndex] === nextItem) return items;
  const nextItems = items.slice();
  nextItems[existingIndex] = nextItem;
  return nextItems;
}

export function upsertManyById<T extends { id: string }>(items: T[], nextItems: T[]): T[] {
  if (!nextItems.length) return items;
  const replacements = new Map(nextItems.map((item) => [item.id, item]));
  let changed = false;
  const merged = items.map((item) => {
    const replacement = replacements.get(item.id);
    if (!replacement) return item;
    replacements.delete(item.id);
    if (replacement !== item) changed = true;
    return replacement;
  });
  if (replacements.size === 0) return changed ? merged : items;
  return [...merged, ...replacements.values()];
}

export function removeById<T extends { id: string }>(items: T[], id: string): T[] {
  const existingIndex = items.findIndex((item) => item.id === id);
  if (existingIndex === -1) return items;
  return [...items.slice(0, existingIndex), ...items.slice(existingIndex + 1)];
}

export function prependById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex === -1) return [nextItem, ...items];
  const nextItems = items.slice();
  nextItems.splice(existingIndex, 1);
  nextItems.unshift(nextItem);
  return nextItems;
}
