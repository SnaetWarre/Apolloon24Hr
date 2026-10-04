import { queryOptions, useQuery } from '@tanstack/react-query';
import type { RaceHistory } from '../types';
import { fetchSinceBase } from './deltaFetch';
import { queryClient } from './queryClient';
import { historyKey } from './snapshot';

export type RaceHistoryRequest =
  | { scope: 'full' }
  | { scope: 'recent'; limit?: number }
  | { scope: 'runner'; runnerId: string };

export function useRaceHistory(request: RaceHistoryRequest = { scope: 'full' }): RaceHistory & {
  initialized: boolean;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<unknown>;
} {
  const normalized = normalizeRequest(request);
  const query = useQuery(raceHistoryQuery(request));
  const fallback: RaceHistory = {
    scope: normalized.scope,
    runnerId: normalized.runnerId,
    limit: normalized.limit,
    laps: [],
    events: [],
    revision: 0,
  };
  return {
    ...(query.data || fallback),
    initialized: query.isSuccess,
    loading: query.isPending,
    error: query.error instanceof Error ? query.error : null,
    refresh: () => query.refetch(),
  };
}

/** Shared by the hook and the route loaders that fetch a page's laps before it opens. */
export function raceHistoryQuery(request: RaceHistoryRequest = { scope: 'full' }) {
  const normalized = normalizeRequest(request);
  const queryKey = [...historyKey, normalized.scope, normalized.runnerId, normalized.limit];
  return queryOptions<RaceHistory, Error>({
    queryKey,
    enabled: normalized.scope !== 'runner' || Boolean(normalized.runnerId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (normalized.scope === 'recent') {
        params.set('scope', 'recent');
        params.set('limit', String(normalized.limit));
      } else if (normalized.scope === 'runner') {
        params.set('runnerId', normalized.runnerId || '');
      }
      // The full history grows by a lap at a time; fetch only the new laps on top of the ones held.
      const base = normalized.scope === 'full' ? queryClient.getQueryData<RaceHistory>(queryKey) : null;
      return fetchSinceBase<RaceHistory>(
        `/api/history${params.size ? `?${params}` : ''}`,
        base,
        async (response) => new Error(`Racegeschiedenis laden mislukt (${response.status})`)
      );
    },
  });
}

function normalizeRequest(request: RaceHistoryRequest): {
  scope: 'full' | 'recent' | 'runner';
  runnerId: string | null;
  limit: number | null;
} {
  if (request.scope === 'runner') {
    return { scope: 'runner', runnerId: request.runnerId, limit: null };
  }
  if (request.scope === 'recent') {
    return {
      scope: 'recent',
      runnerId: null,
      limit: Math.max(1, Math.min(1_000, Math.floor(request.limit || 100))),
    };
  }
  return { scope: 'full', runnerId: null, limit: null };
}
