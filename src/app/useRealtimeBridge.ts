import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { trpc } from '../api';
import { setServerNowMs, syncServerClock } from '../lib/time';
import type { AppSnapshot, Label, LapRecord, RaceEvent, RaceState, Runner } from '../types';
import { patchSnapshot, snapshotKey, upsertById } from './snapshot';

let socket: ReturnType<typeof io> | null = null;
let clockSyncInterval: number | null = null;

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
      socket.on('race-event:created', (event: RaceEvent) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({
          ...snapshot,
          events: [event, ...(snapshot.events || []).filter((item) => item.id !== event.id)],
        }));
      });
      socket.on('race-events:patched', (events: RaceEvent[]) => {
        patchSnapshot(activeQueryClient, (snapshot) => ({ ...snapshot, events }));
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
