import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
export { hasRealtimeConnection } from './realtimeConnection';

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
