import type { Label, LapRecord, Runner } from '../types';
import { compareLabels } from '../../shared/labelOrder';
import { lapPoints } from '../../shared/points';
import { hasPlausibleDuration } from './analysis';

export type RankingMode = 'laps' | 'coefficient';

export type RunnerRankingEntry = {
  runnerId: string;
  runnerNumber: string | null;
  runnerName: string;
  lapCount: number;
  coefficientTotal: number;
  /** Only plausible laps count; null when a runner has none. */
  averageLapMs: number | null;
};

export type RecentLapSummary = {
  lap: LapRecord;
  bestLapMs: number | null;
  averageLapMs: number | null;
};

export function buildRunnerRanking(
  runners: Runner[],
  laps: LapRecord[],
  mode: RankingMode,
  labelId: string | null
): RunnerRankingEntry[] {
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const rankingByRunner = new Map<string, RunnerRankingEntry & { timedLapCount: number; totalLapMs: number }>();

  for (const lap of laps) {
    if (labelId && !lap.labels.some((label) => label.id === labelId)) continue;

    const currentRunner = runnersById.get(lap.runnerId);
    const rankingEntry = rankingByRunner.get(lap.runnerId) ?? {
      runnerId: lap.runnerId,
      runnerNumber: currentRunner?.runnerNumber ?? lap.runnerNumber,
      runnerName: currentRunner?.name ?? lap.runnerName,
      lapCount: 0,
      coefficientTotal: 0,
      averageLapMs: null,
      timedLapCount: 0,
      totalLapMs: 0,
    };
    rankingEntry.lapCount += 1;
    rankingEntry.coefficientTotal += lapPoints(lap);
    if (hasPlausibleDuration(lap)) {
      rankingEntry.timedLapCount += 1;
      rankingEntry.totalLapMs += lap.durationMs;
      rankingEntry.averageLapMs = Math.round(rankingEntry.totalLapMs / rankingEntry.timedLapCount);
    }
    rankingByRunner.set(lap.runnerId, rankingEntry);
  }

  return [...rankingByRunner.values()]
    .map(({ timedLapCount: _timedLapCount, totalLapMs: _totalLapMs, ...rankingEntry }) => rankingEntry)
    .sort((firstRunner, secondRunner) => {
      const primaryDifference =
        mode === 'coefficient'
          ? secondRunner.coefficientTotal - firstRunner.coefficientTotal
          : secondRunner.lapCount - firstRunner.lapCount;
      return (
        primaryDifference ||
        secondRunner.lapCount - firstRunner.lapCount ||
        (firstRunner.averageLapMs ?? Infinity) - (secondRunner.averageLapMs ?? Infinity) ||
        firstRunner.runnerName.localeCompare(secondRunner.runnerName, 'nl-BE')
      );
    });
}

export function buildRecentLapSummaries(laps: LapRecord[], limit = 3): RecentLapSummary[] {
  const durationTotalsByRunner = new Map<string, { count: number; totalMs: number; bestMs: number }>();
  for (const lap of laps) {
    if (!hasPlausibleDuration(lap)) continue;
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
      const totals = durationTotalsByRunner.get(lap.runnerId);
      return {
        lap,
        bestLapMs: totals?.bestMs ?? null,
        averageLapMs: totals ? Math.round(totals.totalMs / totals.count) : null,
      };
    });
}

export function collectRankingLabels(currentLabels: Label[], laps: LapRecord[]): Label[] {
  const labelsById = new Map<string, Label>();
  for (const lap of laps) {
    for (const label of lap.labels) labelsById.set(label.id, label);
  }
  for (const label of currentLabels) labelsById.set(label.id, label);
  return [...labelsById.values()].sort(compareLabels);
}
