import { useQuery } from '@tanstack/react-query';
import type { ClusterStatus } from '../types';
import { clusterStatusKey } from './snapshot';

export function useClusterStatus(): {
  cluster: ClusterStatus | null;
  error: Error | null;
} {
  const query = useQuery({
    queryKey: clusterStatusKey,
    queryFn: async () => {
      const response = await fetch('/api/cluster/status');
      if (!response.ok) throw new Error(`Systeemstatus laden mislukt (${response.status})`);
      return response.json() as Promise<ClusterStatus>;
    },
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  return {
    cluster: query.data ?? null,
    error: query.error instanceof Error ? query.error : null,
  };
}
