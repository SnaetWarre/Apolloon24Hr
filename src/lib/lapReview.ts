import { MAX_HANDOFF_SHIFT_MS, MIN_LAP_MS } from '../../shared/lapTimes';
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
  const medianMs = median(laps.map((lap) => lap.durationMs));
  for (const lap of laps) {
    if (lap.durationMs < medianMs * SHORT_FACTOR) flags.set(lap.id, 'short');
    else if (lap.durationMs > medianMs * LONG_FACTOR) flags.set(lap.id, 'long');
  }
  return { medianMs, flags };
}

/** How far both laps around a press must be off their runners' usual time, and how close those two gaps must be. */
const HANDOFF_OFF_MS = 3_000;
const HANDOFF_MATCH_MS = 1_000;
/** A runner's usual lap needs this many of their other laps. */
const MIN_USUAL_LAPS = 2;

export type HandoffHint = {
  /** How far the press should move: below zero it came too late, above zero too early. */
  shiftMs: number;
  /** The usual lap of the runner before the press and of the runner after it. */
  usualBeforeMs: number;
  usualAfterMs: number;
};

type ReviewedLap = Pick<LapRecord, 'id' | 'runnerId' | 'startedAt' | 'finishedAt' | 'durationMs' | 'source'>;

/**
 * Presses that most likely came too late or too early, by the lap that ended there. A late
 * press makes one runner about as much slower than usual as it makes the next runner faster,
 * as in "Mitras −4, Wout +4". Each runner is held to their own other laps, so a slow runner
 * is not marked for being slow. Two late presses in a row make the press between them look
 * early; each lap explains one press only, the earliest, so that one is left out.
 */
export function reviewHandoffs(laps: readonly ReviewedLap[]): Map<string, HandoffHint> {
  const hints = new Map<string, HandoffHint>();
  const measured = laps
    .filter((lap) => lap.durationMs >= MIN_LAP_MS && lap.source !== 'split')
    .sort((a, b) => a.startedAt - b.startedAt);
  const byRunner = new Map<string, ReviewedLap[]>();
  const byStart = new Map<number, ReviewedLap>();
  for (const lap of measured) {
    byRunner.set(lap.runnerId, [...(byRunner.get(lap.runnerId) ?? []), lap]);
    byStart.set(lap.startedAt, lap);
  }
  const usual = (runnerId: string, skip: ReviewedLap[]) => {
    const others = (byRunner.get(runnerId) ?? []).filter((lap) => !skip.includes(lap)).map((lap) => lap.durationMs);
    return others.length < MIN_USUAL_LAPS ? null : median(others);
  };
  let explained: ReviewedLap | null = null;
  for (const before of measured) {
    const after = byStart.get(before.finishedAt);
    if (!after || before === explained) continue;
    const usualBeforeMs = usual(before.runnerId, [before, after]);
    const usualAfterMs = usual(after.runnerId, [before, after]);
    if (usualBeforeMs === null || usualAfterMs === null) continue;
    const offBefore = before.durationMs - usualBeforeMs;
    const offAfter = after.durationMs - usualAfterMs;
    if (Math.abs(offBefore) < HANDOFF_OFF_MS || Math.abs(offAfter) < HANDOFF_OFF_MS) continue;
    if (Math.sign(offBefore) === Math.sign(offAfter) || Math.abs(offBefore + offAfter) > HANDOFF_MATCH_MS) continue;
    const shiftMs = Math.round((offAfter - offBefore) / 200) * 100;
    if (Math.abs(shiftMs) > MAX_HANDOFF_SHIFT_MS) continue;
    hints.set(before.id, { shiftMs, usualBeforeMs, usualAfterMs });
    explained = after;
  }
  return hints;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
