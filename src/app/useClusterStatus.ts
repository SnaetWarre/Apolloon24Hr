import { useQuery } from '@tanstack/react-query';
import type { ClusterStatus } from '../types';

export function useClusterStatus(): {
  cluster: ClusterStatus | null;
  loading: boolean;
  error: Error | null;
} {
  const query = useQuery({
    queryKey: ['cluster', 'status'],
    queryFn: async () => {
      const response = await fetch('/api/cluster/status');
      if (!response.ok) throw new Error(`Cluster status failed: ${response.status}`);
      return response.json() as Promise<ClusterStatus>;
    },
    refetchInterval: 1_000,
  });

  return {
    cluster: query.data ?? null,
    loading: query.isPending,
    error: query.error instanceof Error ? query.error : null,
  };
}
