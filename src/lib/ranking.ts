import type { Label, LapRecord, Runner } from '../types';

export type RankingMode = 'laps' | 'coefficient';

export type RunnerRankingEntry = {
  runnerId: string;
  runnerNumber: string | null;
  runnerName: string;
  lapCount: number;
  coefficientTotal: number;
  averageLapMs: number;
};

export type RecentLapSummary = {
  lap: LapRecord;
  bestLapMs: number;
  averageLapMs: number;
};

const BASELINE_LAP_MS = 85_000;
const ZERO_POINT_LAP_MS = 90_000;
const FASTER_POINTS_PER_MS = 0.075 / 1_000;
const SLOWER_POINTS_PER_MS = 0.2 / 1_000;

export function calculateLapCoefficient(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > ZERO_POINT_LAP_MS) return 0;
  if (durationMs <= BASELINE_LAP_MS) {
    return 1 + (BASELINE_LAP_MS - durationMs) * FASTER_POINTS_PER_MS;
  }
  return Math.max(0, 1 - (durationMs - BASELINE_LAP_MS) * SLOWER_POINTS_PER_MS);
}

export function buildRunnerRanking(
  runners: Runner[],
  laps: LapRecord[],
  mode: RankingMode,
  labelId: string | null
): RunnerRankingEntry[] {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const rankingByRunner = new Map<string, RunnerRankingEntry & { totalLapMs: number }>();

  for (const lap of laps) {
    if (labelId && !lap.labels.some((label) => label.id === labelId)) continue;

    const currentRunner = runnersById.get(lap.runnerId);
    const rankingEntry = rankingByRunner.get(lap.runnerId) ?? {
      runnerId: lap.runnerId,
      runnerNumber: currentRunner?.runnerNumber ?? lap.runnerNumber,
      runnerName: currentRunner?.name ?? lap.runnerName,
      lapCount: 0,
      coefficientTotal: 0,
      averageLapMs: 0,
      totalLapMs: 0,
    };
    rankingEntry.lapCount += 1;
    rankingEntry.coefficientTotal += calculateLapCoefficient(lap.durationMs);
    rankingEntry.totalLapMs += lap.durationMs;
    rankingEntry.averageLapMs = Math.round(rankingEntry.totalLapMs / rankingEntry.lapCount);
    rankingByRunner.set(lap.runnerId, rankingEntry);
  }

  return [...rankingByRunner.values()]
    .map(({ totalLapMs: _totalLapMs, ...rankingEntry }) => rankingEntry)
    .sort((firstRunner, secondRunner) => {
      const primaryDifference =
        mode === 'coefficient'
          ? secondRunner.coefficientTotal - firstRunner.coefficientTotal
          : secondRunner.lapCount - firstRunner.lapCount;
      return (
        primaryDifference ||
        secondRunner.lapCount - firstRunner.lapCount ||
        firstRunner.averageLapMs - secondRunner.averageLapMs ||
        firstRunner.runnerName.localeCompare(secondRunner.runnerName, 'nl-BE')
      );
    });
}

export function buildRecentLapSummaries(laps: LapRecord[], limit = 3): RecentLapSummary[] {
  const durationTotalsByRunner = new Map<string, { count: number; totalMs: number; bestMs: number }>();
  for (const lap of laps) {
    const totals = durationTotalsByRunner.get(lap.runnerId);
    if (totals) {
      totals.count += 1;
      totals.totalMs += lap.durationMs;
      totals.bestMs = Math.min(totals.bestMs, lap.durationMs);
    } else {
      durationTotalsByRunner.set(lap.runnerId, {
        count: 1,
        totalMs: lap.durationMs,
        bestMs: lap.durationMs,
      });
    }
  }

  return [...laps]
    .sort(
      (firstLap, secondLap) =>
        secondLap.finishedAt - firstLap.finishedAt ||
        secondLap.createdAt - firstLap.createdAt ||
        firstLap.id.localeCompare(secondLap.id)
    )
    .slice(0, Math.max(0, limit))
    .map((lap) => {
      const totals = durationTotalsByRunner.get(lap.runnerId)!;
      return {
        lap,
        bestLapMs: totals.bestMs,
        averageLapMs: Math.round(totals.totalMs / totals.count),
      };
    });
}

export function collectRankingLabels(currentLabels: Label[], laps: LapRecord[]): Label[] {
  const labelsById = new Map<string, Label>();
  for (const lap of laps) {
    for (const label of lap.labels) labelsById.set(label.id, label);
  }
  for (const label of currentLabels) labelsById.set(label.id, label);
  return [...labelsById.values()].sort(
    (firstLabel, secondLabel) =>
      (firstLabel.sortOrder ?? 9_999) - (secondLabel.sortOrder ?? 9_999) ||
      firstLabel.name.localeCompare(secondLabel.name, 'nl-BE')
  );
}
