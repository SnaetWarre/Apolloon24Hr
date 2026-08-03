import { useQuery } from '@tanstack/react-query';
import type { RaceHistory } from '../types';
import { historyKey } from './history';

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
  const query = useQuery<RaceHistory, Error>({
    queryKey: [...historyKey, normalized.scope, normalized.runnerId, normalized.limit],
    enabled: normalized.scope !== 'runner' || Boolean(normalized.runnerId),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (normalized.scope === 'recent') {
        params.set('scope', 'recent');
        params.set('limit', String(normalized.limit));
      } else if (normalized.scope === 'runner') {
        params.set('runnerId', normalized.runnerId || '');
      }
      const response = await fetch(`/api/history${params.size ? `?${params}` : ''}`);
      if (!response.ok) throw new Error(`Racegeschiedenis laden mislukt (${response.status})`);
      return response.json() as Promise<RaceHistory>;
    },
  });
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
