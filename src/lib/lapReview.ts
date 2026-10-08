import type { LapRecord } from '../types';

/*
 * Laps worth a second look in Beheer › Rondes. Every runner runs the same
 * track, so the median lap of the whole race is the yardstick: a lap far below
 * it is most often one press too many, one far above it a missed handoff.
 */

/** Fewer laps than this say too little about a usual lap. */
const MIN_LAPS = 5;
const SHORT_FACTOR = 0.5;
const LONG_FACTOR = 1.75;

export type LapFlag = 'short' | 'long';

export type LapReview = {
  /** The median lap time, or null with too few laps to judge. */
  medianMs: number | null;
  flags: Map<string, LapFlag>;
};

export function reviewLaps(laps: readonly Pick<LapRecord, 'id' | 'durationMs'>[]): LapReview {
  const flags = new Map<string, LapFlag>();
  if (laps.length < MIN_LAPS) return { medianMs: null, flags };
  const sorted = laps.map((lap) => lap.durationMs).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  for (const lap of laps) {
    if (lap.durationMs < medianMs * SHORT_FACTOR) flags.set(lap.id, 'short');
    else if (lap.durationMs > medianMs * LONG_FACTOR) flags.set(lap.id, 'long');
  }
  return { medianMs, flags };
}
