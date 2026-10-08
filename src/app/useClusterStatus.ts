import React from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { ClusterStatus } from '../types';
import { fetchFromLaptop } from '../lib/connectionError';
import { watchClusterStatus } from './realtimeConnection';
import { clusterStatusKey } from './snapshot';
import { useDisconnected } from './useRealtimeBridge';

export const clusterStatusQuery = queryOptions({
  queryKey: clusterStatusKey,
  queryFn: async () => {
    const response = await fetchFromLaptop('/api/cluster/status');
    if (!response.ok) throw new Error(`Systeemstatus laden mislukt (${response.status})`);
    return response.json() as Promise<ClusterStatus>;
  },
  refetchOnWindowFocus: true,
});

/** How often to ask while there is no live connection to push the status. */
const POLL_WITHOUT_CONNECTION_MS = 2_000;

export function useClusterStatus(): {
  cluster: ClusterStatus | null;
  error: Error | null;
} {
  // Pushed over the live connection while it is up; asked for every two seconds while it is not.
  React.useEffect(() => watchClusterStatus(), []);
  const disconnected = useDisconnected();
  const query = useQuery({ ...clusterStatusQuery, refetchInterval: disconnected && POLL_WITHOUT_CONNECTION_MS });

  return {
    cluster: query.data ?? null,
    error: query.error instanceof Error ? query.error : null,
  };
}
