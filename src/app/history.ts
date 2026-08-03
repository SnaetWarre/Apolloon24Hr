import type { QueryClient } from '@tanstack/react-query';
import type { RaceHistory } from '../types';

export const historyKey = ['app', 'history'] as const;

export function patchRaceHistories(
  queryClient: QueryClient,
  updater: (history: RaceHistory) => RaceHistory
): void {
  queryClient.setQueriesData<RaceHistory>({ queryKey: historyKey }, (current) =>
    current ? updater(current) : current
  );
}
