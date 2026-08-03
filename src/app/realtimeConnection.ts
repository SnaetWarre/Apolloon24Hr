let connectedSocketCount = 0;

export function hasRealtimeConnection(): boolean {
  return connectedSocketCount > 0;
}

export function markRealtimeConnected(): void {
  connectedSocketCount += 1;
}

export function markRealtimeDisconnected(): void {
  connectedSocketCount = Math.max(0, connectedSocketCount - 1);
}
