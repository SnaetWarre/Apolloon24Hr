import { formatDurationMs, formatElapsedSeconds } from '../lib/time';
import { LIVE_MILLISECOND_INTERVAL_MS, useClockTick, useSecondTick } from '../lib/useClockTick';

export function LiveDuration({
  startedAt,
  className,
  refreshMs = LIVE_MILLISECOND_INTERVAL_MS,
  format = 'milliseconds',
}: {
  startedAt: number;
  className?: string;
  refreshMs?: number;
  format?: 'milliseconds' | 'seconds';
}) {
  const elapsedMs = useClockTick(refreshMs) - startedAt;
  return (
    <span className={className}>
      {format === 'seconds' ? formatElapsedSeconds(elapsedMs) : formatDurationMs(elapsedMs)}
    </span>
  );
}

export function LiveElapsed({ startedAt, prefix = '' }: { startedAt: number; prefix?: string }) {
  const now = useSecondTick();
  return (
    <>
      {prefix}
      {formatElapsedSeconds(now - startedAt)}
    </>
  );
}
