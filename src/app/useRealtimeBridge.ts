import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { trpc } from '../api';
import { setServerNowMs, syncServerClock } from '../lib/time';
import type { AppSettings, AppSnapshot, Label, LapRecord, RaceEvent, RaceState, Runner, TemporaryTeam } from '../types';
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

    socket.on('bootstrap', (snapshot: AppSnapshot) => {
      setServerNowMs(snapshot.serverNowMs);
      activeQueryClient.setQueryData(snapshotKey, snapshot);
    });
    socket.on('state:revision', (revision: number) => {
      const snapshot = activeQueryClient.getQueryData<AppSnapshot>(snapshotKey);
      if (!snapshot || snapshot.revision !== revision) {
        void activeQueryClient.invalidateQueries({ queryKey: snapshotKey });
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
      patchSnapshot(activeQueryClient, (snapshot) => ({
        ...snapshot,
        laps: prependById(snapshot.laps, lap),
      }));
    });
    socket.on('lap:deleted', (lapId: string) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({
        ...snapshot,
        laps: removeById(snapshot.laps, lapId),
      }));
    });
    socket.on('laps:patched', (laps: LapRecord[]) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, laps }));
    });
    socket.on('race-event:created', (event: RaceEvent) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({
        ...snapshot,
        events: prependById(snapshot.events || [], event),
      }));
    });
    socket.on('race-events:patched', (events: RaceEvent[]) => {
      patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, events }));
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
