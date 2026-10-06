import type { Label, LapRecord, PublicRecordMode, RaceState, Runner } from '../types';
import { compareLabels } from '../../shared/labelOrder';

export type AnalysisFilters = {
  enabledLabelIds: string[] | null;
};

export type DurationStats = {
  count: number;
  averageMs: number | null;
  medianMs: number | null;
  bestMs: number | null;
  slowestMs: number | null;
  standardDeviationMs: number | null;
  totalMs: number;
};

export type AnalysisKpis = DurationStats & {
  lapsPerHour: number | null;
  projected24hLaps: number | null;
  outlierUnderMinuteCount: number;
  outlierOverLimitCount: number;
};

export type TimeBucket = {
  hour: number;
  label: string;
  count: number;
  averageMs: number | null;
};

export type RollingLapTrendPoint = {
  raceHour: number;
  label: string;
  averageMs: number;
  count: number;
};

export type LabelComparison = DurationStats & {
  label: Label;
};

export type DistributionBin = {
  label: string;
  minMs: number;
  maxMs: number | null;
  count: number;
};

export type RunnerInsight = DurationStats & {
  runnerId: string;
  runnerNumber: string | null;
  runnerName: string;
};

export type FastestLapWindow = {
  key: string;
  label: string;
  lap: LapRecord;
  windowIndex: number;
};

/**
 * A lap this long means nobody handed off (the race sat idle or someone forgot
 * the button). It still counts as a lap, but its time would wreck every average.
 */
export const MAX_PLAUSIBLE_LAP_MS = 10 * 60_000;

export function hasPlausibleDuration(lap: Pick<LapRecord, 'durationMs'>): boolean {
  return Number.isFinite(lap.durationMs) && lap.durationMs >= 0 && lap.durationMs <= MAX_PLAUSIBLE_LAP_MS;
}

const BRUSSELS_HOUR_FORMATTER = new Intl.DateTimeFormat('nl-BE', {
  hour: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Brussels',
});

export function filterLaps(laps: LapRecord[], filters: AnalysisFilters): LapRecord[] {
  if (filters.enabledLabelIds === null) return laps;
  if (filters.enabledLabelIds.length === 0) return [];

  const enabledIds = new Set(filters.enabledLabelIds);
  return laps.filter((lap) => {
    if (lap.labels.length === 0) return false;
    return lap.labels.some((label) => enabledIds.has(label.id));
  });
}

function calculateDurationStats(laps: Pick<LapRecord, 'durationMs'>[]): DurationStats {
  const durations = laps
    .filter(hasPlausibleDuration)
    .map((lap) => lap.durationMs)
    .sort((a, b) => a - b);
  const count = durations.length;
  const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
  const averageMs = count > 0 ? Math.round(totalMs / count) : null;
  const medianMs = count > 0 ? median(durations) : null;
  const bestMs = count > 0 ? durations[0] : null;
  const slowestMs = count > 0 ? durations[count - 1] : null;
  const standardDeviationMs =
    count > 1 && averageMs != null
      ? Math.round(Math.sqrt(durations.reduce((sum, duration) => sum + (duration - averageMs) ** 2, 0) / count))
      : null;

  return {
    count,
    averageMs,
    medianMs,
    bestMs,
    slowestMs,
    standardDeviationMs,
    totalMs,
  };
}

export function buildKpis(laps: LapRecord[], race: RaceState): AnalysisKpis {
  const stats = calculateDurationStats(laps);
  const startedAt = race.raceStartedAt ?? oldestLapTimestamp(laps);
  const endedAt = race.raceFinishedAt ?? newestLapTimestamp(laps);
  const elapsedMs = startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : 0;
  const elapsedHours = elapsedMs > 0 ? elapsedMs / 3_600_000 : null;
  const lapsPerHour = elapsedHours ? laps.length / elapsedHours : null;

  return {
    ...stats,
    count: laps.length,
    lapsPerHour,
    projected24hLaps: lapsPerHour != null ? Math.round(lapsPerHour * 24) : null,
    outlierUnderMinuteCount: laps.filter((lap) => lap.durationMs < 60_000).length,
    outlierOverLimitCount: laps.filter((lap) => lap.durationMs > MAX_PLAUSIBLE_LAP_MS).length,
  };
}

export function buildTimeBuckets(laps: LapRecord[], race: RaceState): TimeBucket[] {
  const startedAt = race.raceStartedAt ?? oldestLapTimestamp(laps);
  if (startedAt == null) return [];

  const buckets = new Map<number, { count: number; timedCount: number; totalMs: number }>();
  for (const lap of laps) {
    const hour = Math.max(0, Math.floor((lap.finishedAt - startedAt) / 3_600_000));
    const bucket = buckets.get(hour) ?? { count: 0, timedCount: 0, totalMs: 0 };
    bucket.count += 1;
    if (hasPlausibleDuration(lap)) {
      bucket.timedCount += 1;
      bucket.totalMs += lap.durationMs;
    }
    buckets.set(hour, bucket);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, bucket]) => ({
      hour,
      label: formatClockHourWindow(startedAt, hour),
      count: bucket.count,
      averageMs: bucket.timedCount > 0 ? Math.round(bucket.totalMs / bucket.timedCount) : null,
    }));
}

function formatClockHourWindow(startedAt: number, raceHour: number): string {
  const windowStartedAt = startedAt + raceHour * 3_600_000;
  return `${BRUSSELS_HOUR_FORMATTER.format(windowStartedAt)}u-${BRUSSELS_HOUR_FORMATTER.format(windowStartedAt + 3_600_000)}u`;
}

export function buildRollingLapTrend(laps: LapRecord[], race: RaceState, windowMinutes = 60): RollingLapTrendPoint[] {
  const startedAt = race.raceStartedAt ?? oldestLapTimestamp(laps);
  if (startedAt == null) return [];

  const windowMs = Math.max(1, windowMinutes) * 60_000;
  const sortedLaps = laps.filter(hasPlausibleDuration).sort((a, b) => a.finishedAt - b.finishedAt);
  const points: RollingLapTrendPoint[] = [];
  let windowStartIndex = 0;
  let windowTotalMs = 0;

  for (let groupStart = 0; groupStart < sortedLaps.length;) {
    const finishedAt = sortedLaps[groupStart].finishedAt;
    let groupEnd = groupStart;
    while (groupEnd < sortedLaps.length && sortedLaps[groupEnd].finishedAt === finishedAt) {
      windowTotalMs += sortedLaps[groupEnd].durationMs;
      groupEnd += 1;
    }

    const minimumFinishedAt = finishedAt - windowMs;
    while (windowStartIndex < groupEnd && sortedLaps[windowStartIndex].finishedAt < minimumFinishedAt) {
      windowTotalMs -= sortedLaps[windowStartIndex].durationMs;
      windowStartIndex += 1;
    }

    const count = groupEnd - windowStartIndex;
    const averageMs = count > 0 ? Math.round(windowTotalMs / count) : 0;
    for (let index = groupStart; index < groupEnd; index += 1) {
      const lap = sortedLaps[index];
      const raceHour = Math.max(0, (lap.finishedAt - startedAt) / 3_600_000);
      points.push({
        raceHour,
        label: formatRaceHour(raceHour),
        averageMs: count > 0 ? averageMs : lap.durationMs,
        count,
      });
    }
    groupStart = groupEnd;
  }

  return points;
}

export function buildLabelComparisons(labels: Label[], laps: LapRecord[]): LabelComparison[] {
  const selectedLabels = new Map(labels.map((label) => [label.id, label]));
  const lapsByLabel = new Map<string, LapRecord[]>();
  for (const lap of laps) {
    for (const lapLabel of lap.labels) {
      if (!selectedLabels.has(lapLabel.id)) continue;
      const labelLaps = lapsByLabel.get(lapLabel.id);
      if (labelLaps) labelLaps.push(lap);
      else lapsByLabel.set(lapLabel.id, [lap]);
    }
  }

  return labels
    .map((label) => ({
      label,
      ...calculateDurationStats(lapsByLabel.get(label.id) ?? []),
    }))
    .filter((comparison) => comparison.count > 0)
    .sort((a, b) => compareLabels(a.label, b.label));
}

export function buildDistribution(laps: LapRecord[]): DistributionBin[] {
  const bins: DistributionBin[] = [];
  for (let minMs = 60_000; minMs < 90_000; minMs += 5_000) {
    const maxMs = minMs + 5_000;
    bins.push({
      label: `${formatMinutesSeconds(minMs)}-${formatMinutesSeconds(maxMs)}`,
      minMs,
      maxMs,
      count: 0,
    });
  }
  bins.push({ label: '1:30+', minMs: 90_000, maxMs: null, count: 0 });

  for (const lap of laps) {
    if (lap.durationMs < 60_000 || !hasPlausibleDuration(lap)) continue;
    const binIndex = Math.min(Math.floor((lap.durationMs - 60_000) / 5_000), bins.length - 1);
    bins[binIndex].count += 1;
  }

  return bins;
}

export function buildRunnerInsights(runners: Runner[], laps: LapRecord[]): RunnerInsight[] {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const lapsByRunner = new Map<string, LapRecord[]>();
  const oldestLapByRunner = new Map<string, LapRecord>();

  for (const lap of laps) {
    const runnerLaps = lapsByRunner.get(lap.runnerId);
    if (runnerLaps) runnerLaps.push(lap);
    else lapsByRunner.set(lap.runnerId, [lap]);
    const oldestLap = oldestLapByRunner.get(lap.runnerId);
    if (!oldestLap || lap.finishedAt < oldestLap.finishedAt) {
      oldestLapByRunner.set(lap.runnerId, lap);
    }
  }

  return [...lapsByRunner.entries()]
    .map(([runnerId, runnerLaps]) => {
      const runner = runnersById.get(runnerId);
      const firstLap = oldestLapByRunner.get(runnerId) ?? null;
      return {
        runnerId,
        runnerNumber: runner?.runnerNumber ?? firstLap?.runnerNumber ?? null,
        runnerName: runner?.name ?? firstLap?.runnerName ?? 'Onbekende loper',
        ...calculateDurationStats(runnerLaps),
      };
    })
    .sort(
      (a, b) => b.count - a.count || (a.averageMs ?? Number.MAX_SAFE_INTEGER) - (b.averageMs ?? Number.MAX_SAFE_INTEGER)
    );
}

export function buildFastestLapWindows(
  laps: LapRecord[],
  race: RaceState,
  mode: Exclude<PublicRecordMode, 'off'>
): FastestLapWindow[] {
  if (!laps.length) return [];

  if (mode === 'day') {
    const bestLap = fastestLap(laps);
    return bestLap ? [{ key: 'day', label: 'Dagrecord', lap: bestLap, windowIndex: 0 }] : [];
  }

  const startedAt = race.raceStartedAt ?? oldestLapTimestamp(laps);
  if (startedAt == null) return [];

  const windowMs = recordWindowMs(mode);
  const fastestByWindow = new Map<number, LapRecord>();
  for (const lap of laps) {
    const index = recordWindowIndex(lap.finishedAt, startedAt, windowMs);
    const fastest = fastestByWindow.get(index);
    if (!fastest || compareLapSpeed(lap, fastest) < 0) fastestByWindow.set(index, lap);
  }

  return [...fastestByWindow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([windowIndex, lap]) => ({
      key: `${mode}-${windowIndex}`,
      label: recordWindowLabel(windowIndex, mode),
      lap,
      windowIndex,
    }));
}

export function isFastestLapForRecordMode(
  latestLap: LapRecord,
  previousLaps: LapRecord[],
  race: RaceState,
  mode: PublicRecordMode
): boolean {
  if (mode === 'off') return false;
  if (mode === 'day') return previousLaps.every((lap) => latestLap.durationMs < lap.durationMs);

  const startedAt = race.raceStartedAt ?? oldestLapTimestamp([latestLap, ...previousLaps]);
  if (startedAt == null) return false;
  const windowMs = recordWindowMs(mode);
  const latestWindow = recordWindowIndex(latestLap.finishedAt, startedAt, windowMs);
  return previousLaps
    .filter((lap) => recordWindowIndex(lap.finishedAt, startedAt, windowMs) === latestWindow)
    .every((lap) => latestLap.durationMs < lap.durationMs);
}

export function publicRecordModeTitle(mode: PublicRecordMode): string {
  if (mode === 'hour') return 'Snelste ronde van dit uur';
  if (mode === 'two_hour') return 'Snelste ronde van deze 2 uur';
  return 'Nieuw dagrecord';
}

function fastestLap(laps: LapRecord[]): LapRecord | null {
  let fastest: LapRecord | null = null;
  for (const lap of laps) {
    if (!fastest || compareLapSpeed(lap, fastest) < 0) fastest = lap;
  }
  return fastest;
}

function compareLapSpeed(a: LapRecord, b: LapRecord): number {
  return a.durationMs - b.durationMs || a.finishedAt - b.finishedAt;
}

function recordWindowMs(mode: Exclude<PublicRecordMode, 'off' | 'day'>): number {
  return mode === 'hour' ? 3_600_000 : 7_200_000;
}

function recordWindowIndex(timestamp: number, startedAt: number, windowMs: number): number {
  return Math.max(0, Math.floor((timestamp - startedAt) / windowMs));
}

function recordWindowLabel(index: number, mode: Exclude<PublicRecordMode, 'off'>): string {
  if (mode === 'day') return 'Dagrecord';
  const hoursPerWindow = mode === 'hour' ? 1 : 2;
  const startHour = index * hoursPerWindow;
  return `${startHour}u-${startHour + hoursPerWindow}u`;
}

function formatMinutesSeconds(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatRaceHour(hour: number): string {
  const totalMinutes = Math.round(hour * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}u` : `${hours}u${minutes.toString().padStart(2, '0')}`;
}

function median(sortedValues: number[]): number {
  const midpoint = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[midpoint];
  return Math.round((sortedValues[midpoint - 1] + sortedValues[midpoint]) / 2);
}

function oldestLapTimestamp(laps: LapRecord[]): number | null {
  if (!laps.length) return null;
  let oldest = laps[0].finishedAt;
  for (let index = 1; index < laps.length; index += 1) {
    if (laps[index].finishedAt < oldest) oldest = laps[index].finishedAt;
  }
  return oldest;
}

function newestLapTimestamp(laps: LapRecord[]): number | null {
  if (!laps.length) return null;
  let newest = laps[0].finishedAt;
  for (let index = 1; index < laps.length; index += 1) {
    if (laps[index].finishedAt > newest) newest = laps[index].finishedAt;
  }
  return newest;
}
