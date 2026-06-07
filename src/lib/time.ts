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
  const totalMilliseconds = Math.max(0, Math.floor(totalSeconds * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalWholeSeconds = Math.floor(totalMilliseconds / 1000);
  const hours = Math.floor(totalWholeSeconds / 3600);
  const minutes = Math.floor((totalWholeSeconds % 3600) / 60);
  const seconds = totalWholeSeconds % 60;
  const fraction = milliseconds.toString().padStart(3, '0');

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${fraction}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}.${fraction}`;
}

export function formatDurationMs(ms: number | undefined | null): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  return formatSecondsAsMmSs(ms / 1000);
}

export function formatClockTimeMs(ms: number | undefined | null): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return [
    date.getHours().toString().padStart(2, '0'),
    date.getMinutes().toString().padStart(2, '0'),
    date.getSeconds().toString().padStart(2, '0'),
  ].join(':') + `.${date.getMilliseconds().toString().padStart(3, '0')}`;
}

export function formatElapsedSeconds(ms: number | undefined | null): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function nowMs(): number {
  return Date.now() + serverTimeOffsetMs;
}
