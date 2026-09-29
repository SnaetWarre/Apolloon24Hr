import { useQuery } from '@tanstack/react-query';
import type { AppSettings, HostInfo, Label, LiveAppSnapshot, RaceState, Runner, TemporaryTeam } from '../types';
import { defaultSettings, emptyRace, snapshotKey } from './snapshot';

declare global {
  interface Window {
    __APOLLOON_STATE_PROMISE__?: Promise<LiveAppSnapshot>;
  }
}

type AppQueryState = {
  initialized: boolean;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<unknown>;
};

type FullAppData = {
  runners: Runner[];
  labels: Label[];
  temporaryTeams: TemporaryTeam[];
  race: RaceState;
  settings: AppSettings;
  host: HostInfo | null;
};

const emptySnapshot: LiveAppSnapshot = {
  runners: [],
  labels: [],
  temporaryTeams: [],
  race: emptyRace,
  settings: defaultSettings,
  revision: 0,
  host: { hostIpHint: '', port: 1, url: '' },
};

async function fetchSnapshot(): Promise<LiveAppSnapshot> {
  // index.html starts this request before the bundle loads; use it once.
  const prefetched = window.__APOLLOON_STATE_PROMISE__;
  if (prefetched) {
    delete window.__APOLLOON_STATE_PROMISE__;
    return prefetched;
  }
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error(`Serverstatus laden mislukt (${response.status})`);
  return (await response.json()) as LiveAppSnapshot;
}

export function useAppData(): FullAppData & AppQueryState;
export function useAppData<TSelected extends object>(
  selector: (snapshot: LiveAppSnapshot) => TSelected
): TSelected & AppQueryState;
export function useAppData<TSelected extends object>(
  selector?: (snapshot: LiveAppSnapshot) => TSelected
): (FullAppData | TSelected) & AppQueryState {
  const query = useQuery<LiveAppSnapshot, Error, LiveAppSnapshot | TSelected>({
    queryKey: snapshotKey,
    queryFn: fetchSnapshot,
    select: selector,
  });

  const selectedData = query.data ?? (selector ? selector(emptySnapshot) : emptySnapshot);
  const data = selector
    ? selectedData
    : {
        ...(selectedData as LiveAppSnapshot),
        host: query.data ? (selectedData as LiveAppSnapshot).host : null,
      };

  return {
    ...data,
    initialized: query.isSuccess,
    loading: query.isPending,
    error: query.error instanceof Error ? query.error : null,
    refresh: () => query.refetch(),
  } as (FullAppData | TSelected) & AppQueryState;
}
