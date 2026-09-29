import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getRealtimeConnectionSnapshot, subscribeRealtimeConnection } from './realtimeConnection';
export { hasRealtimeConnection } from './realtimeConnection';

/** True als de verbinding er was en nu weg is (verberg vóór de eerste connectie). */
export function useConnectionLost(): boolean {
  const snapshot = React.useSyncExternalStore(
    subscribeRealtimeConnection,
    getRealtimeConnectionSnapshot,
    getRealtimeConnectionSnapshot
  );
  return snapshot.everConnected && !snapshot.connected;
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
