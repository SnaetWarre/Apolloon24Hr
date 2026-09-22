let connectedSocketCount = 0;
let everConnected = false;

type ConnectionSnapshot = { connected: boolean; everConnected: boolean };
let snapshot: ConnectionSnapshot = { connected: false, everConnected: false };
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = { connected: connectedSocketCount > 0, everConnected };
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Een kapotte luisteraar mag de rest nooit blokkeren.
    }
  }
}

export function hasRealtimeConnection(): boolean {
  return connectedSocketCount > 0;
}

export function markRealtimeConnected(): void {
  connectedSocketCount += 1;
  everConnected = true;
  publish();
}

export function markRealtimeDisconnected(): void {
  connectedSocketCount = Math.max(0, connectedSocketCount - 1);
  publish();
}

export function subscribeRealtimeConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRealtimeConnectionSnapshot(): ConnectionSnapshot {
  return snapshot;
}
