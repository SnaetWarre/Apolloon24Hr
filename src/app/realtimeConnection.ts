let connectedSocketCount = 0;
let everConnected = false;

type ConnectionSnapshot = { connected: boolean; everConnected: boolean };
let snapshot: ConnectionSnapshot = { connected: false, everConnected: false };
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = { connected: connectedSocketCount > 0, everConnected };
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken listener must never block the others.
    }
  }
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

// Screens that show the group status; while there are any, the live connection carries it.
let clusterWatchers = 0;
const clusterWatchListeners = new Set<() => void>();

export function watchClusterStatus(): () => void {
  clusterWatchers += 1;
  for (const listener of clusterWatchListeners) listener();
  return () => {
    clusterWatchers -= 1;
    for (const listener of clusterWatchListeners) listener();
  };
}

export function isClusterStatusWatched(): boolean {
  return clusterWatchers > 0;
}

export function onClusterWatchersChanged(listener: () => void): () => void {
  clusterWatchListeners.add(listener);
  return () => {
    clusterWatchListeners.delete(listener);
  };
}
