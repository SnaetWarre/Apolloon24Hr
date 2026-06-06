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
  return Date.now();
}

