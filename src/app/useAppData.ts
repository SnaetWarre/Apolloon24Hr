import { useQuery } from '@tanstack/react-query';
import { trpc } from '../api';
import { setServerNowMs } from '../lib/time';
import type { AppSettings, HostInfo, Label, LapRecord, RaceEvent, RaceState, Runner } from '../types';
import { defaultSettings, emptyRace, snapshotKey } from './snapshot';

export function useAppData(): {
  runners: Runner[];
  labels: Label[];
  laps: LapRecord[];
  events: RaceEvent[];
  race: RaceState;
  settings: AppSettings;
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
    events: query.data?.events ?? [],
    race: query.data?.race ?? emptyRace,
    settings: query.data?.settings ?? defaultSettings,
    host: query.data?.host ?? null,
    initialized: query.isSuccess,
    loading: query.isPending,
    error: query.error instanceof Error ? query.error : null,
    refresh: () => query.refetch(),
  };
}
