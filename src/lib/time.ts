let serverTimeOffsetMs = 0;
const syncListeners = new Set<() => void>();

export { formatClockTimeMs, formatDurationMs, formatElapsedSeconds } from '../../shared/time';

async function fetchServerNow(): Promise<number> {
  const response = await fetch('/api/time', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Servertijd ophalen mislukt (${response.status})`);
  return ((await response.json()) as { serverNowMs: number }).serverNowMs;
}

/** Estimates the server clock offset from the fastest of a few round trips. */
export async function syncServerClock(
  samples = 3,
  serverNow: () => Promise<number> = fetchServerNow
): Promise<{ offsetMs: number; roundTripMs: number }> {
  let best: { offsetMs: number; roundTripMs: number } | null = null;

  for (let i = 0; i < samples; i += 1) {
    const startedAt = Date.now();
    const serverNowMs = await serverNow();
    const roundTripMs = Date.now() - startedAt;
    const offsetMs = serverNowMs - (startedAt + roundTripMs / 2);
    if (!best || roundTripMs < best.roundTripMs) best = { offsetMs, roundTripMs };
  }
  if (!best) throw new Error('server clock sync failed');
  serverTimeOffsetMs = best.offsetMs;
  for (const listener of syncListeners) listener();
  return best;
}

/** The current time on the server's clock, which stamps every lap. */
export function nowMs(): number {
  return Date.now() + serverTimeOffsetMs;
}

/** Calls `listener` after every sync, which can move nowMs() against this laptop's clock. */
export function onServerClockSync(listener: () => void): () => void {
  syncListeners.add(listener);
  return () => syncListeners.delete(listener);
}
