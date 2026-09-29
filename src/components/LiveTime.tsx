import { formatDurationMs, formatElapsedSeconds, nowMs } from '../lib/time';
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
  useClockTick(refreshMs);
  const elapsedMs = nowMs() - startedAt;
  return (
    <span className={className}>
      {format === 'seconds' ? formatElapsedSeconds(elapsedMs) : formatDurationMs(elapsedMs)}
    </span>
  );
}

export function LiveElapsed({ startedAt, prefix = '' }: { startedAt: number; prefix?: string }) {
  useSecondTick();
  return (
    <>
      {prefix}
      {formatElapsedSeconds(nowMs() - startedAt)}
    </>
  );
}
