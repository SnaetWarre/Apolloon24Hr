import React from 'react';
import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { trpc } from './api';
import { setServerNowMs, syncServerClock } from './lib/time';
import type { AppSnapshot, HostInfo, Label, LapRecord, RaceState, Runner, RunnerInput, RunnerPatch, RunnerStatus } from './types';
import type { RealtimeEvent } from '../server/realtime';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    },
  },
});

const snapshotKey = ['app', 'snapshot'] as const;

const emptyRace: RaceState = {
  id: 1,
  activeRunnerId: null,
  activeStartedAt: null,
  raceStartedAt: null,
  raceFinishedAt: null,
};

let socket: ReturnType<typeof io> | null = null;
let clockSyncInterval: number | null = null;

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

export function useRealtimeBridge(): void {
  const activeQueryClient = useQueryClient();

  React.useEffect(() => {
    const syncClock = () =>
      syncServerClock(5, async () => {
        const payload = await trpc.state.time.query();
        return payload.serverNowMs;
      }).catch(() => undefined);

    if (!socket) {
      socket = io('/');
      socket.on('bootstrap', (snapshot: AppSnapshot) => {
        setServerNowMs(snapshot.serverNowMs);
        activeQueryClient.setQueryData(snapshotKey, snapshot);
      });
      socket.on('runner:upserted', (runner: Runner) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({
          ...snapshot,
          runners: upsertById(snapshot.runners, runner),
        }));
      });
      socket.on('runner:deleted', (runnerId: string) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({
          ...snapshot,
          runners: snapshot.runners.filter((runner) => runner.id !== runnerId),
        }));
      });
      socket.on('runners:patched', (runners: Runner[]) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, runners }));
      });
      socket.on('queue:patched', (runners: Runner[]) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, runners }));
      });
      socket.on('label:upserted', (label: Label) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({
          ...snapshot,
          labels: upsertById(snapshot.labels, label),
        }));
      });
      socket.on('label:deleted', (labelId: string) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({
          ...snapshot,
          labels: snapshot.labels.filter((label) => label.id !== labelId),
        }));
      });
      socket.on('labels:patched', (labels: Label[]) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, labels }));
      });
      socket.on('race:changed', (race: RaceState) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, race }));
      });
      socket.on('lap:created', (lap: LapRecord) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({
          ...snapshot,
          laps: [lap, ...snapshot.laps.filter((item) => item.id !== lap.id)],
        }));
      });
      socket.on('lap:deleted', (lapId: string) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({
          ...snapshot,
          laps: snapshot.laps.filter((lap) => lap.id !== lapId),
        }));
      });
      socket.on('laps:patched', (laps: LapRecord[]) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, laps }));
      });
      socket.on('connect', () => {
        void syncClock();
        void activeQueryClient.invalidateQueries({ queryKey: snapshotKey });
      });
      socket.on('reconnect', () => {
        void syncClock();
        void activeQueryClient.invalidateQueries({ queryKey: snapshotKey });
      });
    }

    if (clockSyncInterval === null) {
      void syncClock();
      clockSyncInterval = window.setInterval(syncClock, 30_000);
    }
  }, [activeQueryClient]);
}

export function useAppActions() {
  const activeQueryClient = useQueryClient();
  const { runners } = useAppData();

  const refreshSnapshot = React.useCallback(async () => {
    await activeQueryClient.invalidateQueries({ queryKey: snapshotKey });
  }, [activeQueryClient]);

  return React.useMemo(
    () => ({
      async addRunner(input: string | RunnerInput) {
        const body = typeof input === 'string' ? { name: input } : input;
        await trpc.runners.create.mutate(body);
        await refreshSnapshot();
      },
      async updateRunner(id: string, input: RunnerPatch) {
        await trpc.runners.update.mutate({ id, fields: input });
        await refreshSnapshot();
      },
      async setStatus(id: string, status: RunnerStatus) {
        await trpc.runners.setStatus.mutate({ id, status });
        await refreshSnapshot();
      },
      async moveInQueue(id: string, newIndex: number) {
        const waiting = runners
          .filter((runner) => runner.status === 'waiting')
          .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0));
        const oldIndex = waiting.findIndex((runner) => runner.id === id);
        if (oldIndex === -1) return;
        const [moved] = waiting.splice(oldIndex, 1);
        waiting.splice(newIndex, 0, moved);
        await trpc.runners.reorder.mutate({ ids: waiting.map((runner) => runner.id) });
        await refreshSnapshot();
      },
      async deleteRunner(id: string) {
        await trpc.runners.delete.mutate({ id });
        await refreshSnapshot();
      },
      async hideRunner(id: string) {
        await trpc.runners.hide.mutate({ id });
        await refreshSnapshot();
      },
      async unhideRunner(id: string) {
        await trpc.runners.unhide.mutate({ id });
        await refreshSnapshot();
      },
      async createLabel(input: {
        name: string;
        color: string;
        icon: string;
        kind: string;
        imageUrl?: string | null;
        targetLaps?: number | null;
        sortOrder?: number | null;
      }) {
        await trpc.labels.create.mutate(input);
        await refreshSnapshot();
      },
      async updateLabel(
        id: string,
        input: Partial<Pick<Label, 'name' | 'color' | 'icon' | 'kind' | 'imageUrl' | 'targetLaps' | 'sortOrder'>>
      ) {
        await trpc.labels.update.mutate({ id, fields: input });
        await refreshSnapshot();
      },
      async deleteLabel(id: string) {
        await trpc.labels.delete.mutate({ id });
        await refreshSnapshot();
      },
      async importRunnersCsv(csvText: string) {
        const summary = await trpc.runners.importCsv.mutate({ csvText });
        await refreshSnapshot();
        return `${summary.created} aangemaakt, ${summary.updated} bijgewerkt, ${summary.skipped} overgeslagen`;
      },
      async handoff() {
        await trpc.race.handoff.mutate();
        await refreshSnapshot();
      },
      async startNext() {
        await trpc.race.startNext.mutate();
        await refreshSnapshot();
      },
      async undoLastHandoff() {
        await trpc.race.undoLastHandoff.mutate();
        await refreshSnapshot();
      },
      async finishRace() {
        await trpc.race.finish.mutate();
        await refreshSnapshot();
      },
    }),
    [refreshSnapshot, runners]
  );
}

function patchSnapshot(queryClientToPatch: QueryClient, updater: (snapshot: AppSnapshot) => AppSnapshot): void {
  queryClientToPatch.setQueryData<AppSnapshot>(snapshotKey, (current) => {
    if (!current) return current;
    return updater(current);
  });
}

function upsertById<T extends { id: string }>(items: T[], nextItem: T): T[] {
  const existingIndex = items.findIndex((item) => item.id === nextItem.id);
  if (existingIndex === -1) return [...items, nextItem];
  return items.map((item, index) => (index === existingIndex ? nextItem : item));
}
