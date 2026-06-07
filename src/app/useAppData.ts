import { useQuery } from '@tanstack/react-query';
import { trpc } from '../api';
import { setServerNowMs } from '../lib/time';
import type { HostInfo, Label, LapRecord, RaceState, Runner } from '../types';
import { emptyRace, snapshotKey } from './snapshot';

export function useAppData(): {
  runners: Runner[];
  labels: Label[];
  laps: LapRecord[];
  race: RaceState;
  host: HostInfo | null;
  initialized: boolean;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: snapshotKey,
    queryFn: async () => {
      const snapshot = await trpc.state.snapshot.query();
      setServerNowMs(snapshot.serverNowMs);
      return snapshot;
    },
  });

  return {
    runners: query.data?.runners ?? [],
    labels: query.data?.labels ?? [],
    laps: query.data?.laps ?? [],
    race: query.data?.race ?? emptyRace,
    host: query.data?.host ?? null,
    initialized: query.isSuccess,
    loading: query.isPending,
    error: query.error instanceof Error ? query.error : null,
    refresh: () => query.refetch(),
  };
}
