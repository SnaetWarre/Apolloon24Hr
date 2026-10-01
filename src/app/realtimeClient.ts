import type { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client';
import type { AppRouter } from '../../server/router';
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

  const wsClient = createWSClient({
    url: `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/trpc`,
    // Retry after 1 s, backing off to at most 5 s.
    retryDelayMs: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    // A laptop that drops off the network shows as disconnected within seconds.
    keepAlive: { enabled: true, intervalMs: 5_000, pongTimeoutMs: 5_000 },
    onOpen: () => {
      if (!connected) {
        connected = true;
        markRealtimeConnected();
      }
      void queryClient.invalidateQueries({ queryKey: clusterStatusKey });
      void syncClock();
    },
    onClose: () => {
      if (connected) {
        connected = false;
        markRealtimeDisconnected();
      }
    },
  });
  const client = createTRPCClient<AppRouter>({ links: [wsLink({ client: wsClient })] });

  // Resubscribed on every reconnect, which sends the current revision again.
  const subscription = client.live.revision.subscribe(undefined, {
    onData: (revision) => {
      if (queryClient.getQueryData<LiveAppSnapshot>(snapshotKey)?.revision !== revision) {
        void queryClient.invalidateQueries({ queryKey: appKey });
      }
    },
  });

  const clockSyncInterval = window.setInterval(() => void syncClock(), 120_000);

  return () => {
    disposed = true;
    window.clearInterval(clockSyncInterval);
    if (connected) {
      connected = false;
      markRealtimeDisconnected();
    }
    subscription.unsubscribe();
    void wsClient.close();
  };
}
