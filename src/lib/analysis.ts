import type { Label, LapRecord, RaceState, Runner } from '../types';

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
  latestVsFirstMs: number | null;
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
  const bins = [
    { label: '1:00-1:10', minMs: 60_000, maxMs: 70_000, count: 0 },
    { label: '1:10-1:20', minMs: 70_000, maxMs: 80_000, count: 0 },
    { label: '1:20-1:30', minMs: 80_000, maxMs: 90_000, count: 0 },
    { label: '1:30-1:40', minMs: 90_000, maxMs: 100_000, count: 0 },
    { label: '1:40-1:50', minMs: 100_000, maxMs: 110_000, count: 0 },
    { label: '1:50-2:00', minMs: 110_000, maxMs: 120_000, count: 0 },
    { label: '2:00+', minMs: 120_000, maxMs: null, count: 0 },
  ];

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
      const latestLap = sortedLaps[sortedLaps.length - 1] ?? null;
      return {
        runnerId,
        runnerNumber: runner?.runnerNumber ?? firstLap?.runnerNumber ?? null,
        runnerName: runner?.name ?? firstLap?.runnerName ?? 'Onbekende loper',
        latestVsFirstMs:
          firstLap && latestLap && firstLap.id !== latestLap.id ? latestLap.durationMs - firstLap.durationMs : null,
        ...calculateDurationStats(sortedLaps),
      };
    })
    .sort((a, b) => b.count - a.count || (a.averageMs ?? Number.MAX_SAFE_INTEGER) - (b.averageMs ?? Number.MAX_SAFE_INTEGER));
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
