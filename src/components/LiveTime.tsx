import { formatDurationMs, formatElapsedSeconds, nowMs } from '../lib/time';
import {
  LIVE_MILLISECOND_INTERVAL_MS,
  useClockTick,
  useSecondTick,
} from '../lib/useAnimationFrameTick';

export function LiveDuration({
  startedAt,
  className,
  refreshMs = LIVE_MILLISECOND_INTERVAL_MS,
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
  useSecondTick();
  return <>{prefix}{formatElapsedSeconds(nowMs() - startedAt)}</>;
}
