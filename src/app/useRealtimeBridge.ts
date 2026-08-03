import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { trpc } from '../api';
import { setServerNowMs, syncServerClock } from '../lib/time';
import type { AppSettings, Label, LapRecord, LiveAppSnapshot, RaceEvent, RaceHistory, RaceState, Runner, TemporaryTeam } from '../types';
import { historyKey, patchRaceHistories } from './history';
import {
  patchSnapshot,
  prependById,
  removeById,
  snapshotKey,
  upsertById,
  upsertManyById,
} from './snapshot';

const connectedSockets = new Set<ReturnType<typeof io>>();

export function hasRealtimeConnection(): boolean {
  return connectedSockets.size > 0;
}

export function useRealtimeBridge(enabled = true): void {
  const activeQueryClient = useQueryClient();

  React.useEffect(() => {
    if (!enabled) return undefined;

    let disposed = false;
    let clockSyncInFlight = false;
    const socket = io('/');

    const syncClock = async () => {
      if (disposed || clockSyncInFlight) return;
      clockSyncInFlight = true;
      try {
        await syncServerClock(3, async () => {
          const payload = await trpc.state.time.query();
          return payload.serverNowMs;
        });
      } catch {
        // The snapshot query and Socket.IO reconnect will retry when the local server returns.
      } finally {
        clockSyncInFlight = false;
      }
    };

    socket.on('state:revision', (revision: number) => {
      const snapshot = activeQueryClient.getQueryData<LiveAppSnapshot>(snapshotKey);
      if (!snapshot || snapshot.revision !== revision) {
        void activeQueryClient.invalidateQueries({ queryKey: snapshotKey });
        void activeQueryClient.invalidateQueries({ queryKey: historyKey });
      }
    });
    socket.on('runner:upserted', (runner: Runner) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({
        ...snapshot,
        runners: upsertById(snapshot.runners, runner),
      }));
    });
    socket.on('runners:upserted', (runners: Runner[]) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({
        ...snapshot,
        runners: upsertManyById(snapshot.runners, runners),
      }));
    });
    socket.on('runner:deleted', (runnerId: string) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({
        ...snapshot,
        runners: removeById(snapshot.runners, runnerId),
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
        labels: removeById(snapshot.labels, labelId),
      }));
    });
    socket.on('labels:patched', (labels: Label[]) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, labels }));
    });
    socket.on('race:changed', (race: RaceState) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, race }));
    });
    socket.on('lap:created', (lap: LapRecord) => {
      patchRaceHistories(activeQueryClient, (history) => patchHistoryLap(history, lap));
    });
    socket.on('lap:deleted', (lapId: string) => {
      patchRaceHistories(activeQueryClient, (history) => ({
        ...history,
        laps: removeById(history.laps, lapId),
      }));
    });
    socket.on('laps:patched', (laps: LapRecord[]) => {
      patchRaceHistories(activeQueryClient, (history) => ({
        ...history,
        laps: historyLapsForScope(history, laps),
      }));
    });
    socket.on('race-event:created', (event: RaceEvent) => {
      patchRaceHistories(activeQueryClient, (history) =>
        history.scope === 'runner'
          ? history
          : {
              ...history,
              events: limitHistory(history, prependById(history.events, event)),
            }
      );
    });
    socket.on('race-events:patched', (events: RaceEvent[]) => {
      patchRaceHistories(activeQueryClient, (history) => ({
        ...history,
        events:
          history.scope === 'runner'
            ? []
            : limitHistory(history, events),
      }));
    });
    socket.on('settings:changed', (settings: AppSettings) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, settings }));
    });
    socket.on('temporary-teams:patched', (temporaryTeams: TemporaryTeam[]) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, temporaryTeams }));
    });
    socket.on('connect', () => {
      connectedSockets.add(socket);
      void syncClock();
    });
    socket.on('disconnect', () => {
      connectedSockets.delete(socket);
    });

    void syncClock();
    const clockSyncInterval = window.setInterval(() => void syncClock(), 120_000);

    return () => {
      disposed = true;
      window.clearInterval(clockSyncInterval);
      connectedSockets.delete(socket);
      socket.disconnect();
    };
  }, [activeQueryClient, enabled]);
}

function patchHistoryLap(history: RaceHistory, lap: LapRecord): RaceHistory {
  if (history.scope === 'runner' && history.runnerId !== lap.runnerId) return history;
  return {
    ...history,
    laps: limitHistory(history, prependById(history.laps, lap)),
  };
}

function historyLapsForScope(history: RaceHistory, laps: LapRecord[]): LapRecord[] {
  const matching =
    history.scope === 'runner'
      ? laps.filter((lap) => lap.runnerId === history.runnerId)
      : laps;
  return limitHistory(history, matching);
}

function limitHistory<T>(history: RaceHistory, items: T[]): T[] {
  return history.scope === 'recent' && history.limit
    ? items.slice(0, history.limit)
    : items;
}
