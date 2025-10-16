export function formatSecondsAsMmSs(totalSeconds: number | undefined | null): string {
  if (totalSeconds == null || Number.isNaN(totalSeconds)) return '—';
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function formatDurationMs(ms: number | undefined | null): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  return formatSecondsAsMmSs(ms / 1000);
}

export function nowMs(): number {
  return Date.now();
}


