import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getRealtimeConnectionSnapshot, subscribeRealtimeConnection } from './realtimeConnection';

function useConnectionSnapshot() {
  return React.useSyncExternalStore(
    subscribeRealtimeConnection,
    getRealtimeConnectionSnapshot,
    getRealtimeConnectionSnapshot
  );
}

/** True when the live connection existed and is gone; quiet while the first connection is still being made. */
export function useConnectionLost(): boolean {
  const snapshot = useConnectionSnapshot();
  return snapshot.everConnected && !snapshot.connected;
}

/** True whenever there is no live connection, including when it never came up. */
export function useDisconnected(): boolean {
  return !useConnectionSnapshot().connected;
}

export function useRealtimeBridge(enabled = true): void {
  const activeQueryClient = useQueryClient();

  React.useEffect(() => {
    if (!enabled) return undefined;

    let disposed = false;
    let disconnect: (() => void) | null = null;
    void import('./realtimeClient').then(({ connectRealtime }) => {
      if (disposed) return;
      disconnect = connectRealtime(activeQueryClient);
    });

    return () => {
      disposed = true;
      disconnect?.();
    };
  }, [activeQueryClient, enabled]);
}
