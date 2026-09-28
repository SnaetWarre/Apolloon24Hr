let serverTimeOffsetMs = 0;

export {
  formatClockTimeMs,
  formatDurationMs,
  formatElapsedSeconds,
} from '../../shared/time';

function setServerTimeOffsetMs(offsetMs: number): void {
  if (!Number.isFinite(offsetMs)) return;
  serverTimeOffsetMs = offsetMs;
}

export function setServerNowMs(serverNowMs: number, clientNowMs = Date.now()): void {
  if (!Number.isFinite(serverNowMs)) return;
  setServerTimeOffsetMs(serverNowMs - clientNowMs);
}

async function fetchServerNowOverHttp(startedAt: number): Promise<number> {
  const res = await fetch(`/api/time?t=${startedAt}`, { cache: 'no-store' });
  const payload = (await res.json()) as { serverNowMs: number };
  return payload.serverNowMs;
}

export async function syncServerClock(
  samples = 5,
  fetchServerNow: (startedAt: number) => Promise<number> = fetchServerNowOverHttp
): Promise<{ offsetMs: number; roundTripMs: number }> {
  let best: { offsetMs: number; roundTripMs: number } | null = null;

  for (let i = 0; i < samples; i += 1) {
    const startedAt = Date.now();
    const serverNowMs = await fetchServerNow(startedAt);
    const endedAt = Date.now();
    const roundTripMs = endedAt - startedAt;
    const clientMidpointMs = startedAt + roundTripMs / 2;
    const offsetMs = serverNowMs - clientMidpointMs;

    if (!best || roundTripMs < best.roundTripMs) {
      best = { offsetMs, roundTripMs };
    }
  }

  if (!best) {
    throw new Error('server clock sync failed');
  }

  setServerTimeOffsetMs(best.offsetMs);
  return best;
}

export function nowMs(): number {
  return Date.now() + serverTimeOffsetMs;
}
