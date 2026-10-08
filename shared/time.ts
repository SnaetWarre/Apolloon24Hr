function formatSecondsAsMmSs(totalSeconds: number | undefined | null): string {
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

const BRUSSELS_CLOCK_FORMATTER = new Intl.DateTimeFormat('nl-BE', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Brussels',
});

/** Brussels clock time with milliseconds, e.g. "20:35:10.123", whatever zone this screen is set to. */
export function formatClockTimeMs(ms: number | undefined | null): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return `${BRUSSELS_CLOCK_FORMATTER.format(date)}.${date.getMilliseconds().toString().padStart(3, '0')}`;
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

const BRUSSELS_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Brussels',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** How far Brussels clock time is ahead of UTC at that moment: 1 h in winter, 2 h in summer. */
export function brusselsOffsetMs(atMs: number): number {
  const parts = Object.fromEntries(BRUSSELS_PARTS.formatToParts(atMs).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(atMs / 1000) * 1000;
}
