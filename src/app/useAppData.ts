import { useQuery } from '@tanstack/react-query';
import { trpc } from '../api';
import { setServerNowMs } from '../lib/time';
import type {
  AppSettings,
  AppSnapshot,
  HostInfo,
  Label,
  LapRecord,
  RaceEvent,
  RaceState,
  Runner,
  TemporaryTeam,
} from '../types';
import { defaultSettings, emptyRace, snapshotKey } from './snapshot';

type AppQueryState = {
  initialized: boolean;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<unknown>;
};

type FullAppData = {
  runners: Runner[];
  labels: Label[];
  laps: LapRecord[];
  events: RaceEvent[];
  temporaryTeams: TemporaryTeam[];
  race: RaceState;
  settings: AppSettings;
  host: HostInfo | null;
};

const emptySnapshot: AppSnapshot = {
  runners: [],
  labels: [],
  laps: [],
  events: [],
  temporaryTeams: [],
  race: emptyRace,
  settings: defaultSettings,
  revision: 0,
  serverNowMs: 0,
  host: {
    hostIpHint: '',
    port: 1,
    url: '',
  },
};

export function useAppData(): FullAppData & AppQueryState;
export function useAppData<TSelected extends object>(
  selector: (snapshot: AppSnapshot) => TSelected
): TSelected & AppQueryState;
export function useAppData<TSelected extends object>(
  selector?: (snapshot: AppSnapshot) => TSelected
): (FullAppData | TSelected) & AppQueryState {
  const query = useQuery<AppSnapshot, Error, AppSnapshot | TSelected>({
    queryKey: snapshotKey,
    queryFn: async () => {
      const snapshot = await trpc.state.snapshot.query();
      setServerNowMs(snapshot.serverNowMs);
      return snapshot;
    },
    select: selector,
  });

  const selectedData = query.data ?? (selector ? selector(emptySnapshot) : emptySnapshot);
  const data = selector
    ? selectedData
    : {
        ...(selectedData as AppSnapshot),
        host: query.data ? (selectedData as AppSnapshot).host : null,
      };

  return {
    ...data,
    initialized: query.isSuccess,
    loading: query.isPending,
    error: query.error instanceof Error ? query.error : null,
    refresh: () => query.refetch(),
  } as (FullAppData | TSelected) & AppQueryState;
}
