import { formatDurationMs, formatElapsedSeconds, nowMs } from '../lib/time';
import { useClockTick } from '../lib/useAnimationFrameTick';

export function LiveDuration({
  startedAt,
  className,
  refreshMs = 100,
}: {
  startedAt: number;
  className?: string;
  refreshMs?: number;
}) {
  useClockTick(refreshMs);
  return <span className={className}>{formatDurationMs(nowMs() - startedAt)}</span>;
}

export function LiveElapsed({
  startedAt,
  prefix = '',
}: {
  startedAt: number;
  prefix?: string;
}) {
  useClockTick(1_000);
  return <>{prefix}{formatElapsedSeconds(nowMs() - startedAt)}</>;
}
