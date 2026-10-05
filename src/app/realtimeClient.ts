import type { QueryClient } from '@tanstack/react-query';
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client';
import type { AppRouter } from '../../server/router';
import { syncServerClock } from '../lib/time';
import type { LiveAppSnapshot } from '../types';
import {
  isClusterStatusWatched,
  markRealtimeConnected,
  markRealtimeDisconnected,
  onClusterWatchersChanged,
} from './realtimeConnection';
import { appKey, clusterStatusKey, snapshotKey } from './snapshot';

/**
 * A laptop that lost power or its cable never answers the closing handshake,
 * and the browser then waits about a minute before it reports the socket
 * closed. This socket reports it as soon as it is closed, so a screen notices
 * a dead laptop within the keepalive below instead.
 */
class PromptlyClosingWebSocket extends WebSocket {
  private reportedClosed = false;

  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    // The browser's own events for this socket, when they finally come, were already reported.
    const swallowLate = (event: Event) => {
      if (this.reportedClosed && event.isTrusted) event.stopImmediatePropagation();
    };
    this.addEventListener('error', swallowLate);
    this.addEventListener('close', swallowLate);
  }

  override close(code?: number, reason?: string): void {
    super.close(code, reason);
    if (this.reportedClosed || this.readyState === WebSocket.CLOSED) return;
    this.reportedClosed = true;
    this.dispatchEvent(new CloseEvent('close', { code: code ?? 1000, reason, wasClean: false }));
  }
}

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
    WebSocket: PromptlyClosingWebSocket,
    // Retry after 1 s, backing off to at most 5 s.
    retryDelayMs: (attempt) => Math.min(1_000 * 2 ** attempt, 5_000),
    // A laptop that drops off the network shows as disconnected within 2.5 s. Being disconnected
    // alone never moves a screen to another laptop (useFailover.ts), so a slow answer costs a reconnect at most.
    keepAlive: { enabled: true, intervalMs: 1_000, pongTimeoutMs: 1_500 },
    onOpen: () => {
      if (!connected) {
        connected = true;
        markRealtimeConnected();
      }
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

  // The group status arrives when it changes, for as long as a screen shows it.
  let clusterSubscription: { unsubscribe: () => void } | null = null;
  const followClusterWatchers = () => {
    if (isClusterStatusWatched() && !clusterSubscription) {
      clusterSubscription = client.live.cluster.subscribe(undefined, {
        onData: (status) => queryClient.setQueryData(clusterStatusKey, status),
      });
    } else if (!isClusterStatusWatched() && clusterSubscription) {
      clusterSubscription.unsubscribe();
      clusterSubscription = null;
    }
  };
  const stopFollowingClusterWatchers = onClusterWatchersChanged(followClusterWatchers);
  followClusterWatchers();

  const clockSyncInterval = window.setInterval(() => void syncClock(), 120_000);

  return () => {
    disposed = true;
    window.clearInterval(clockSyncInterval);
    if (connected) {
      connected = false;
      markRealtimeDisconnected();
    }
    subscription.unsubscribe();
    stopFollowingClusterWatchers();
    clusterSubscription?.unsubscribe();
    void wsClient.close();
  };
}
