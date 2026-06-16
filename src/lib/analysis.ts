import type { Label, LapRecord, PublicRecordMode, RaceState, Runner } from '../types';

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

export function isSpeedteamLabel(label: Pick<Label, 'kind' | 'name'>): boolean {
  return label.kind === 'speedteam' || label.name.toLowerCase().includes('speedteam');
}

export function filterLaps(laps: LapRecord[], filters: AnalysisFilters): LapRecord[] {
  if (filters.enabledLabelIds === null) return laps;
  if (filters.enabledLabelIds.length === 0) return [];

  const enabledIds = new Set(filters.enabledLabelIds);
  return laps.filter((lap) => {
    if (lap.labels.length === 0) return false;
    return lap.labels.some((label) => enabledIds.has(label.id));
  });
}

export function calculateDurationStats(laps: Pick<LapRecord, 'durationMs'>[]): DurationStats {
  const durations = laps
    .map((lap) => lap.durationMs)
    .filter((duration) => Number.isFinite(duration) && duration >= 0)
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
  const lapsPerHour = elapsedHours ? stats.count / elapsedHours : null;

  return {
    ...stats,
    lapsPerHour,
    projected24hLaps: lapsPerHour != null ? Math.round(lapsPerHour * 24) : null,
    outlierUnderMinuteCount: laps.filter((lap) => lap.durationMs < 60_000).length,
  };
}

export function buildTimeBuckets(laps: LapRecord[], race: RaceState): TimeBucket[] {
  const startedAt = race.raceStartedAt ?? oldestLapTimestamp(laps);
  if (startedAt == null) return [];

  const buckets = new Map<number, LapRecord[]>();
  for (const lap of laps) {
    const hour = Math.max(0, Math.floor((lap.finishedAt - startedAt) / 3_600_000));
    buckets.set(hour, [...(buckets.get(hour) ?? []), lap]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, bucketLaps]) => ({
      hour,
      label: `${hour}u-${hour + 1}u`,
      count: bucketLaps.length,
      averageMs: calculateDurationStats(bucketLaps).averageMs,
    }));
}

export function buildRollingLapTrend(
  laps: LapRecord[],
  race: RaceState,
  windowMinutes = 60
): RollingLapTrendPoint[] {
  const startedAt = race.raceStartedAt ?? oldestLapTimestamp(laps);
  if (startedAt == null) return [];

  const windowMs = Math.max(1, windowMinutes) * 60_000;
  const sortedLaps = [...laps].sort((a, b) => a.finishedAt - b.finishedAt);

  return sortedLaps.map((lap) => {
    const windowStart = lap.finishedAt - windowMs;
    const windowLaps = sortedLaps.filter(
      (item) => item.finishedAt >= windowStart && item.finishedAt <= lap.finishedAt
    );
    const averageMs = calculateDurationStats(windowLaps).averageMs ?? lap.durationMs;
    const raceHour = Math.max(0, (lap.finishedAt - startedAt) / 3_600_000);

    return {
      raceHour,
      label: formatRaceHour(raceHour),
      averageMs,
      count: windowLaps.length,
    };
  });
}

export function buildLabelComparisons(labels: Label[], laps: LapRecord[]): LabelComparison[] {
  return labels
    .map((label) => ({
      label,
      ...calculateDurationStats(laps.filter((lap) => lap.labels.some((item) => item.id === label.id))),
    }))
    .filter((comparison) => comparison.count > 0)
    .sort(
      (a, b) =>
        (a.label.sortOrder ?? 9999) - (b.label.sortOrder ?? 9999) ||
        a.label.name.localeCompare(b.label.name)
    );
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
    const bin = bins.find((item) => lap.durationMs >= item.minMs && (item.maxMs == null || lap.durationMs < item.maxMs));
    if (bin) bin.count += 1;
  }

  return bins;
}

export function buildRunnerInsights(runners: Runner[], laps: LapRecord[]): RunnerInsight[] {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const lapsByRunner = new Map<string, LapRecord[]>();

  for (const lap of laps) {
    lapsByRunner.set(lap.runnerId, [...(lapsByRunner.get(lap.runnerId) ?? []), lap]);
  }

  return [...lapsByRunner.entries()]
    .map(([runnerId, runnerLaps]) => {
      const sortedLaps = [...runnerLaps].sort((a, b) => a.finishedAt - b.finishedAt);
      const runner = runnersById.get(runnerId);
      const firstLap = sortedLaps[0] ?? null;
      return {
        runnerId,
        runnerNumber: runner?.runnerNumber ?? firstLap?.runnerNumber ?? null,
        runnerName: runner?.name ?? firstLap?.runnerName ?? 'Onbekende loper',
        ...calculateDurationStats(sortedLaps),
      };
    })
    .sort((a, b) => b.count - a.count || (a.averageMs ?? Number.MAX_SAFE_INTEGER) - (b.averageMs ?? Number.MAX_SAFE_INTEGER));
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
  const buckets = new Map<number, LapRecord[]>();
  for (const lap of laps) {
    const index = recordWindowIndex(lap.finishedAt, startedAt, windowMs);
    buckets.set(index, [...(buckets.get(index) ?? []), lap]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([windowIndex, bucketLaps]) => ({
      key: `${mode}-${windowIndex}`,
      label: recordWindowLabel(windowIndex, mode),
      lap: fastestLap(bucketLaps) as LapRecord,
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
  if (mode === 'hour') return 'NEW HOUR RECORD';
  if (mode === 'two_hour') return 'NEW 2H RECORD';
  return 'NEW DAY RECORD';
}

function fastestLap(laps: LapRecord[]): LapRecord | null {
  return [...laps].sort((a, b) => a.durationMs - b.durationMs || a.finishedAt - b.finishedAt)[0] ?? null;
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
  return laps.length ? Math.min(...laps.map((lap) => lap.finishedAt)) : null;
}

function newestLapTimestamp(laps: LapRecord[]): number | null {
  return laps.length ? Math.max(...laps.map((lap) => lap.finishedAt)) : null;
}
