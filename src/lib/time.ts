let serverTimeOffsetMs = 0;

export function setServerTimeOffsetMs(offsetMs: number): void {
  if (!Number.isFinite(offsetMs)) return;
  serverTimeOffsetMs = offsetMs;
}

export function setServerNowMs(serverNowMs: number, clientNowMs = Date.now()): void {
  if (!Number.isFinite(serverNowMs)) return;
  setServerTimeOffsetMs(serverNowMs - clientNowMs);
}

export function getServerTimeOffsetMs(): number {
  return serverTimeOffsetMs;
}

export async function syncServerClock(samples = 5): Promise<{ offsetMs: number; roundTripMs: number }> {
  let best: { offsetMs: number; roundTripMs: number } | null = null;

  for (let i = 0; i < samples; i += 1) {
    const startedAt = Date.now();
    const res = await fetch(`/api/time?t=${startedAt}`, { cache: 'no-store' });
    const payload = (await res.json()) as { serverNowMs: number };
    const endedAt = Date.now();
    const roundTripMs = endedAt - startedAt;
    const clientMidpointMs = startedAt + roundTripMs / 2;
    const offsetMs = payload.serverNowMs - clientMidpointMs;

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

export function formatSecondsAsMmSs(totalSeconds: number | undefined | null): string {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return '—';
  const totalCentiseconds = Math.max(0, Math.floor(totalSeconds * 100));
  const centiseconds = totalCentiseconds % 100;
  const totalWholeSeconds = Math.floor(totalCentiseconds / 100);
  const hours = Math.floor(totalWholeSeconds / 3600);
  const minutes = Math.floor((totalWholeSeconds % 3600) / 60);
  const seconds = totalWholeSeconds % 60;
  const fraction = centiseconds.toString().padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${fraction}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}.${fraction}`;
}

export function formatDurationMs(ms: number | undefined | null): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  return formatSecondsAsMmSs(ms / 1000);
}

export function nowMs(): number {
  return Date.now() + serverTimeOffsetMs;
}
