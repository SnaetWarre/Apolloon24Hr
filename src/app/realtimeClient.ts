import type { QueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { syncServerClock } from '../lib/time';
import type { LiveAppSnapshot } from '../types';
import { markRealtimeConnected, markRealtimeDisconnected } from './realtimeConnection';
import { appKey, clusterStatusKey, snapshotKey } from './snapshot';

/**
 * The server announces its data revision after every committed change; a
 * client that holds another revision refetches. Refetching the cached, ETag'd
 * snapshot keeps every screen on exactly the server's state.
 */
export function connectRealtime(queryClient: QueryClient): () => void {
  let disposed = false;
  let connected = false;
  let clockSyncInFlight = false;
  const socket = io('/');

  const syncClock = async () => {
    if (disposed || clockSyncInFlight) return;
    clockSyncInFlight = true;
    try {
      await syncServerClock();
    } catch {
      // Retried on the next reconnect or interval.
    } finally {
      clockSyncInFlight = false;
    }
  };

  socket.on('state:revision', (revision: number) => {
    if (queryClient.getQueryData<LiveAppSnapshot>(snapshotKey)?.revision !== revision) {
      void queryClient.invalidateQueries({ queryKey: appKey });
    }
  });
  socket.on('connect', () => {
    if (!connected) {
      connected = true;
      markRealtimeConnected();
    }
    void queryClient.invalidateQueries({ queryKey: clusterStatusKey });
    void syncClock();
  });
  socket.on('disconnect', () => {
    if (connected) {
      connected = false;
      markRealtimeDisconnected();
    }
  });

  const clockSyncInterval = window.setInterval(() => void syncClock(), 120_000);

  return () => {
    disposed = true;
    window.clearInterval(clockSyncInterval);
    if (connected) {
      connected = false;
      markRealtimeDisconnected();
    }
    socket.disconnect();
  };
}
