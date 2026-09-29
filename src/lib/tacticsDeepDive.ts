import type { LapRecord } from '../types';
import { targetLapCountAt, type HistoricalRace, type HistoricalTeam } from './tactics';

const RACE_SECONDS = 24 * 3_600;

export type PaceSummary = {
  teamId: number;
  teamName: string;
  laps: number;
  medianSeconds: number;
  p10Seconds: number;
  p90Seconds: number;
  standardDeviationSeconds: number;
};

export type PacePoint = {
  raceHour: number;
  firstSeconds: number | null;
  secondSeconds: number | null;
};

export type ConsistencyPoint = PacePoint & {
  firstP10Seconds: number | null;
  firstP90Seconds: number | null;
  secondP10Seconds: number | null;
  secondP90Seconds: number | null;
  firstStandardDeviationSeconds: number | null;
  secondStandardDeviationSeconds: number | null;
};

export type DistributionSummary = {
  laps: number;
  medianSeconds: number | null;
  interquartileRangeSeconds: number | null;
  outlierCount: number;
};

export type RaceLeadPoint = {
  raceHour: number;
  lapDifference: number;
};

export type TimeGapPoint = {
  raceHour: number;
  gapSeconds: number;
  predicted?: boolean;
};

export type LiveTrendPoint = {
  raceHour: number;
  liveSeconds: number | null;
  ownHistoricalSeconds: number | null;
  rivalHistoricalSeconds: number | null;
};

export type HourlyGainPoint = {
  raceHour: number;
  lapDifference: number;
  cumulativeLapDifference: number;
};

export type PaceDifferencePoint = {
  raceHour: number;
  differenceSeconds: number | null;
};

export type SameLapGapPoint = {
  raceHour: number;
  lapNumber: number;
  gapSeconds: number;
};

export type SlowLap = {
  lapNumber: number;
  raceHour: number;
  durationSeconds: number;
};

export type PaceChange = SlowLap & {
  baselineSeconds: number;
  differenceSeconds: number;
};

export type BreakEvenResult = {
  currentAverageSeconds: number;
  requiredAverageSeconds: number;
  improvementSeconds: number;
  improvementPercent: number;
  currentLaps: number;
  targetLaps: number;
};

export type GroupComparison = {
  label: string;
  firstCount: number;
  secondCount: number;
  firstMedianSeconds: number | null;
  secondMedianSeconds: number | null;
  effectSeconds: number | null;
  pValue: number | null;
};

export type DraftingTeamAnalysis = {
  teamId: number;
  teamName: string;
  signedGapSeconds: number[];
  lapDurationsSeconds: number[];
  proximityBins: Array<{ label: string; medianSeconds: number | null; count: number }>;
  comparisons: GroupComparison[];
};

export function summarizeHistoricalTeams(race: HistoricalRace): PaceSummary[] {
  return race.teams
    .map((team) => {
      const durationsSeconds = team.lapDurationsMs.map((durationMs) => durationMs / 1_000);
      return {
        teamId: team.teamId,
        teamName: team.teamName,
        laps: team.cumulativeLapTimesMs.length,
        medianSeconds: median(durationsSeconds) ?? 0,
        p10Seconds: quantile(durationsSeconds, 0.1) ?? 0,
        p90Seconds: quantile(durationsSeconds, 0.9) ?? 0,
        standardDeviationSeconds: standardDeviation(durationsSeconds),
      };
    })
    .sort((firstTeam, secondTeam) => secondTeam.laps - firstTeam.laps || firstTeam.teamId - secondTeam.teamId);
}

export function buildQuarterHourPaces(
  firstTeam: HistoricalTeam,
  secondTeam: HistoricalTeam,
  startHour = 0,
  endHour = 24
): PacePoint[] {
  const boundedStartHour = clamp(startHour, 0, 23.75);
  const boundedEndHour = clamp(endHour, boundedStartHour + 0.25, 24);
  const points: PacePoint[] = [];
  for (let raceHour = boundedStartHour; raceHour < boundedEndHour; raceHour += 0.25) {
    points.push({
      raceHour: raceHour + 0.125,
      firstSeconds: paceMedianInWindow(firstTeam, raceHour, raceHour + 0.25),
      secondSeconds: paceMedianInWindow(secondTeam, raceHour, raceHour + 0.25),
    });
  }
  return points;
}

export function buildHourlyConsistency(firstTeam: HistoricalTeam, secondTeam: HistoricalTeam): ConsistencyPoint[] {
  return Array.from({ length: 24 }, (_, raceHour) => {
    const firstDurations = durationsInWindow(firstTeam, raceHour, raceHour + 1);
    const secondDurations = durationsInWindow(secondTeam, raceHour, raceHour + 1);
    return {
      raceHour: raceHour + 0.5,
      firstSeconds: median(firstDurations),
      secondSeconds: median(secondDurations),
      firstP10Seconds: quantile(firstDurations, 0.1),
      firstP90Seconds: quantile(firstDurations, 0.9),
      secondP10Seconds: quantile(secondDurations, 0.1),
      secondP90Seconds: quantile(secondDurations, 0.9),
      firstStandardDeviationSeconds: firstDurations.length >= 3 ? standardDeviation(firstDurations) : null,
      secondStandardDeviationSeconds: secondDurations.length >= 3 ? standardDeviation(secondDurations) : null,
    };
  });
}

export function summarizeHistoricalWindow(team: HistoricalTeam, startHour = 0, endHour = 24): DistributionSummary {
  const durations = durationsInWindow(team, startHour, endHour);
  const firstQuartile = quantile(durations, 0.25);
  const thirdQuartile = quantile(durations, 0.75);
  if (firstQuartile == null || thirdQuartile == null) {
    return {
      laps: durations.length,
      medianSeconds: median(durations),
      interquartileRangeSeconds: null,
      outlierCount: 0,
    };
  }
  const interquartileRangeSeconds = thirdQuartile - firstQuartile;
  const lowerFence = firstQuartile - 1.5 * interquartileRangeSeconds;
  const upperFence = thirdQuartile + 1.5 * interquartileRangeSeconds;
  return {
    laps: durations.length,
    medianSeconds: median(durations),
    interquartileRangeSeconds,
    outlierCount: durations.filter((duration) => duration < lowerFence || duration > upperFence).length,
  };
}

export function smoothPacePoints(points: PacePoint[], windowSize = 12): PacePoint[] {
  const radius = Math.max(1, Math.floor(windowSize / 2));
  return points.map((point, pointIndex) => ({
    raceHour: point.raceHour,
    firstSeconds: mean(
      points
        .slice(Math.max(0, pointIndex - radius), pointIndex + radius + 1)
        .map((candidate) => candidate.firstSeconds)
        .filter((pace): pace is number => pace != null)
    ),
    secondSeconds: mean(
      points
        .slice(Math.max(0, pointIndex - radius), pointIndex + radius + 1)
        .map((candidate) => candidate.secondSeconds)
        .filter((pace): pace is number => pace != null)
    ),
  }));
}

export function buildHalfHourPaceDifferences(
  firstTeam: HistoricalTeam,
  secondTeam: HistoricalTeam,
  startHour = 0,
  endHour = 24
): PaceDifferencePoint[] {
  const points: PaceDifferencePoint[] = [];
  for (let raceHour = startHour; raceHour < endHour; raceHour += 0.5) {
    const firstAverage = mean(durationsInWindow(firstTeam, raceHour, raceHour + 0.5));
    const secondAverage = mean(durationsInWindow(secondTeam, raceHour, raceHour + 0.5));
    points.push({
      raceHour: raceHour + 0.25,
      differenceSeconds: firstAverage == null || secondAverage == null ? null : firstAverage - secondAverage,
    });
  }
  return points;
}

export function calculateNightPenalty(
  team: HistoricalTeam,
  nightStartHour = 3,
  nightEndHour = 9
): { dayMedianSeconds: number | null; nightMedianSeconds: number | null; penaltySeconds: number | null } {
  const nightDurations: number[] = [];
  const dayDurations: number[] = [];
  team.cumulativeLapTimesMs.forEach((timestampMs, lapIndex) => {
    const raceHour = timestampMs / 3_600_000;
    const durationSeconds = team.lapDurationsMs[lapIndex] / 1_000;
    if (raceHour >= nightStartHour && raceHour < nightEndHour) nightDurations.push(durationSeconds);
    else dayDurations.push(durationSeconds);
  });
  const dayMedianSeconds = median(dayDurations);
  const nightMedianSeconds = median(nightDurations);
  return {
    dayMedianSeconds,
    nightMedianSeconds,
    penaltySeconds:
      dayMedianSeconds == null || nightMedianSeconds == null ? null : nightMedianSeconds - dayMedianSeconds,
  };
}

export function buildTimeGapCurve(
  focusTeam: HistoricalTeam,
  rivalTeam: HistoricalTeam,
  intervalMinutes = 5
): TimeGapPoint[] {
  const focusTimesSeconds = trimmedCumulativeSeconds(focusTeam);
  const rivalTimesSeconds = trimmedCumulativeSeconds(rivalTeam);
  if (!focusTimesSeconds.length || !rivalTimesSeconds.length) return [];

  const intervalSeconds = Math.max(10, intervalMinutes * 60);
  const points: TimeGapPoint[] = [];
  for (let timestampSeconds = 0; timestampSeconds <= RACE_SECONDS; timestampSeconds += intervalSeconds) {
    const rivalProgress = interpolatedProgress(rivalTimesSeconds, timestampSeconds);
    const focusTimestamp = interpolatedTimestamp(focusTimesSeconds, rivalProgress);
    points.push({ raceHour: timestampSeconds / 3_600, gapSeconds: focusTimestamp - timestampSeconds });
  }
  return points;
}

export function buildHourlyLapGains(firstTeam: HistoricalTeam, secondTeam: HistoricalTeam): HourlyGainPoint[] {
  let cumulativeLapDifference = 0;
  return Array.from({ length: 24 }, (_, raceHour) => {
    const firstLaps = lapCountInWindow(firstTeam, raceHour, raceHour + 1);
    const secondLaps = lapCountInWindow(secondTeam, raceHour, raceHour + 1);
    const lapDifference = secondLaps - firstLaps;
    cumulativeLapDifference += lapDifference;
    return { raceHour, lapDifference, cumulativeLapDifference };
  });
}

export function buildRaceLeadCurve(
  firstTeam: HistoricalTeam,
  secondTeam: HistoricalTeam,
  intervalMinutes = 5
): RaceLeadPoint[] {
  const intervalMs = Math.max(10, intervalMinutes * 60) * 1_000;
  const points: RaceLeadPoint[] = [];
  for (let timestampMs = 0; timestampMs <= RACE_SECONDS * 1_000; timestampMs += intervalMs) {
    points.push({
      raceHour: timestampMs / 3_600_000,
      lapDifference:
        upperBound(firstTeam.cumulativeLapTimesMs, timestampMs) -
        upperBound(secondTeam.cumulativeLapTimesMs, timestampMs),
    });
  }
  return points;
}

export function buildSameLapIndexGap(firstTeam: HistoricalTeam, secondTeam: HistoricalTeam): SameLapGapPoint[] {
  const sharedLapCount = Math.min(firstTeam.cumulativeLapTimesMs.length, secondTeam.cumulativeLapTimesMs.length);
  return Array.from({ length: sharedLapCount }, (_, lapIndex) => {
    const firstTimestampMs = firstTeam.cumulativeLapTimesMs[lapIndex];
    const secondTimestampMs = secondTeam.cumulativeLapTimesMs[lapIndex];
    return {
      raceHour: (firstTimestampMs + secondTimestampMs) / 2 / 3_600_000,
      lapNumber: lapIndex + 1,
      gapSeconds: (firstTimestampMs - secondTimestampMs) / 1_000,
    };
  });
}

export function buildLiveQuarterHourTrend(
  liveLaps: LapRecord[],
  raceStartedAt: number,
  elapsedHours: number,
  ownHistoricalTeam: HistoricalTeam | null,
  rivalHistoricalTeam: HistoricalTeam | null
): LiveTrendPoint[] {
  const points: LiveTrendPoint[] = [];
  for (let raceHour = 0; raceHour < 24; raceHour += 0.25) {
    const liveDurations = liveLaps
      .filter((lap) => {
        const lapHour = (lap.finishedAt - raceStartedAt) / 3_600_000;
        return lapHour >= raceHour && lapHour < raceHour + 0.25;
      })
      .map((lap) => lap.durationMs / 1_000);
    points.push({
      raceHour: raceHour + 0.125,
      liveSeconds: raceHour <= elapsedHours ? median(liveDurations) : null,
      ownHistoricalSeconds: ownHistoricalTeam ? paceMedianInWindow(ownHistoricalTeam, raceHour, raceHour + 0.25) : null,
      rivalHistoricalSeconds: rivalHistoricalTeam
        ? paceMedianInWindow(rivalHistoricalTeam, raceHour, raceHour + 0.25)
        : null,
    });
  }
  return points;
}

export function buildLiveRivalTimeGap(
  liveLaps: LapRecord[],
  raceStartedAt: number,
  elapsedHours: number,
  targetPacesSeconds: number[],
  rivalHistoricalTeam: HistoricalTeam | null,
  intervalMinutes = 5
): TimeGapPoint[] {
  if (!rivalHistoricalTeam || !liveLaps.length) return [];
  const boundedElapsedHours = clamp(elapsedHours, 0, 24);
  const liveProgressCurve = [
    { timestampSeconds: 0, progress: 0 },
    ...liveLaps.map((lap, lapIndex) => ({
      timestampSeconds: Math.max(0, (lap.finishedAt - raceStartedAt) / 1_000),
      progress: lapIndex + 1,
    })),
  ];
  const completedLaps = liveLaps.length;
  const targetAtNow = targetLapCountAt(targetPacesSeconds, boundedElapsedHours);
  for (let raceHour = boundedElapsedHours; raceHour <= 24.0001; raceHour += intervalMinutes / 60) {
    liveProgressCurve.push({
      timestampSeconds: raceHour * 3_600,
      progress: completedLaps + targetLapCountAt(targetPacesSeconds, raceHour) - targetAtNow,
    });
  }
  liveProgressCurve.sort((firstPoint, secondPoint) => firstPoint.timestampSeconds - secondPoint.timestampSeconds);
  const rivalTimesSeconds = trimmedCumulativeSeconds(rivalHistoricalTeam);
  const points: TimeGapPoint[] = [];
  for (let raceHour = 0; raceHour <= 24.0001; raceHour += intervalMinutes / 60) {
    const timestampSeconds = raceHour * 3_600;
    const rivalProgress = interpolatedProgress(rivalTimesSeconds, timestampSeconds);
    const liveTimestamp = interpolateCurveTimestamp(liveProgressCurve, rivalProgress);
    points.push({
      raceHour,
      gapSeconds: liveTimestamp - timestampSeconds,
      predicted: raceHour > boundedElapsedHours,
    });
  }
  return points;
}

export function projectScenarioRange(
  completedLaps: number,
  elapsedHours: number,
  targetPacesSeconds: number[],
  paceSpreadSeconds: number
): { optimisticLaps: number; expectedLaps: number; pessimisticLaps: number } {
  const boundedElapsedHours = clamp(elapsedHours, 0, 24);
  const remainingLaps = (paceOffsetSeconds: number) => {
    let projectedLaps = completedLaps;
    for (let raceHour = Math.floor(boundedElapsedHours); raceHour < 24; raceHour += 1) {
      const coveredFraction = raceHour === Math.floor(boundedElapsedHours) ? 1 - (boundedElapsedHours - raceHour) : 1;
      const paceSeconds = Math.max(1, (targetPacesSeconds[raceHour] ?? 1) + paceOffsetSeconds);
      projectedLaps += (coveredFraction * 3_600) / paceSeconds;
    }
    return projectedLaps;
  };
  const spread = Math.max(0, paceSpreadSeconds);
  return {
    optimisticLaps: remainingLaps(-spread),
    expectedLaps: remainingLaps(0),
    pessimisticLaps: remainingLaps(spread),
  };
}

export function findSlowLaps(team: HistoricalTeam, thresholdSeconds: number): SlowLap[] {
  return team.lapDurationsMs
    .map((durationMs, lapIndex) => ({
      lapNumber: lapIndex + 1,
      raceHour: team.cumulativeLapTimesMs[lapIndex] / 3_600_000,
      durationSeconds: durationMs / 1_000,
    }))
    .filter((lap) => lap.durationSeconds > thresholdSeconds)
    .sort((firstLap, secondLap) => secondLap.durationSeconds - firstLap.durationSeconds);
}

export function findPaceChanges(team: HistoricalTeam, thresholdSeconds = 8, movingWindow = 5): PaceChange[] {
  const durationsSeconds = team.lapDurationsMs.map((durationMs) => durationMs / 1_000);
  return durationsSeconds
    .map((durationSeconds, lapIndex) => {
      const windowStart = Math.max(0, lapIndex - movingWindow);
      const baselineSeconds = mean(durationsSeconds.slice(windowStart, lapIndex)) ?? durationSeconds;
      return {
        lapNumber: lapIndex + 1,
        raceHour: team.cumulativeLapTimesMs[lapIndex] / 3_600_000,
        durationSeconds,
        baselineSeconds,
        differenceSeconds: durationSeconds - baselineSeconds,
      };
    })
    .filter((lap, lapIndex) => lapIndex >= movingWindow && Math.abs(lap.differenceSeconds) > thresholdSeconds)
    .sort((firstLap, secondLap) => Math.abs(secondLap.differenceSeconds) - Math.abs(firstLap.differenceSeconds));
}

export function calculateBreakEven(improvingTeam: HistoricalTeam, targetTeam: HistoricalTeam): BreakEvenResult | null {
  const currentAverageSeconds = mean(improvingTeam.lapDurationsMs.map((durationMs) => durationMs / 1_000));
  if (currentAverageSeconds == null || targetTeam.cumulativeLapTimesMs.length === 0) return null;
  const requiredAverageSeconds = RACE_SECONDS / targetTeam.cumulativeLapTimesMs.length;
  const improvementSeconds = currentAverageSeconds - requiredAverageSeconds;
  return {
    currentAverageSeconds,
    requiredAverageSeconds,
    improvementSeconds,
    improvementPercent: (improvementSeconds / currentAverageSeconds) * 100,
    currentLaps: improvingTeam.cumulativeLapTimesMs.length,
    targetLaps: targetTeam.cumulativeLapTimesMs.length,
  };
}

export function buildBreakEvenSensitivity(
  improvingTeam: HistoricalTeam,
  maximumImprovementSeconds = 15
): Array<{ improvementSeconds: number; projectedLaps: number }> {
  const averageSeconds = mean(improvingTeam.lapDurationsMs.map((durationMs) => durationMs / 1_000));
  if (averageSeconds == null) return [];
  const maximum = Math.min(maximumImprovementSeconds, Math.max(0, averageSeconds - 5));
  const points: Array<{ improvementSeconds: number; projectedLaps: number }> = [];
  for (let improvementSeconds = 0; improvementSeconds <= maximum + 0.001; improvementSeconds += 0.5) {
    points.push({
      improvementSeconds,
      projectedLaps: Math.floor(RACE_SECONDS / (averageSeconds - improvementSeconds)),
    });
  }
  return points;
}

export function analyzeDrafting(
  focusTeam: HistoricalTeam,
  otherTeam: HistoricalTeam,
  options: {
    startHour: number;
    endHour: number;
    closeSeconds: number;
    farSeconds: number;
    minimumLapSeconds: number;
    maximumLapSeconds: number;
  }
): DraftingTeamAnalysis {
  const focusLaps = cleanDraftingLaps(focusTeam, options);
  const otherLaps = cleanDraftingLaps(otherTeam, options);
  const signedGapSeconds = focusLaps.timestampsSeconds.map((focusTimestamp) =>
    nearestSignedGap(focusTimestamp, otherLaps.timestampsSeconds)
  );
  const behind: number[] = [];
  const ahead: number[] = [];
  const far: number[] = [];
  const close: number[] = [];
  signedGapSeconds.forEach((signedGap, lapIndex) => {
    const durationSeconds = focusLaps.durationsSeconds[lapIndex];
    if (Math.abs(signedGap) <= options.closeSeconds) close.push(durationSeconds);
    if (signedGap > 0 && Math.abs(signedGap) <= options.closeSeconds) behind.push(durationSeconds);
    if (signedGap < 0 && Math.abs(signedGap) <= options.closeSeconds) ahead.push(durationSeconds);
    if (Math.abs(signedGap) >= options.farSeconds) far.push(durationSeconds);
  });

  const proximityEdges = [0, 5, 10, 15, 20, 30, Infinity];
  const proximityBins = proximityEdges.slice(0, -1).map((lowerBound, binIndex) => {
    const upperBound = proximityEdges[binIndex + 1];
    const binDurations = focusLaps.durationsSeconds.filter((_, lapIndex) => {
      const absoluteGap = Math.abs(signedGapSeconds[lapIndex]);
      return absoluteGap >= lowerBound && absoluteGap < upperBound;
    });
    return {
      label: upperBound === Infinity ? '30s+' : `${lowerBound}-${upperBound}s`,
      medianSeconds: binDurations.length >= 4 ? median(binDurations) : null,
      count: binDurations.length,
    };
  });

  return {
    teamId: focusTeam.teamId,
    teamName: focusTeam.teamName,
    signedGapSeconds,
    lapDurationsSeconds: focusLaps.durationsSeconds,
    proximityBins,
    comparisons: [
      compareGroups('Dichtbij vs. ver weg', close, far),
      compareGroups('Achteraan dichtbij vs. ver weg', behind, far),
      compareGroups('Vooraan dichtbij vs. ver weg', ahead, far),
      compareGroups('Achteraan vs. vooraan dichtbij', behind, ahead),
    ],
  };
}

export function defaultSlowLapThreshold(firstTeam: HistoricalTeam, secondTeam: HistoricalTeam): number {
  const durationsSeconds = [...firstTeam.lapDurationsMs, ...secondTeam.lapDurationsMs].map(
    (durationMs) => durationMs / 1_000
  );
  return Math.round((quantile(durationsSeconds, 0.9) ?? 90) / 5) * 5;
}

function durationsInWindow(team: HistoricalTeam, startHour: number, endHour: number): number[] {
  return team.lapDurationsMs
    .map((durationMs, lapIndex) => ({
      raceHour: team.cumulativeLapTimesMs[lapIndex] / 3_600_000,
      durationSeconds: durationMs / 1_000,
    }))
    .filter((lap) => lap.raceHour >= startHour && lap.raceHour < endHour)
    .map((lap) => lap.durationSeconds);
}

function paceMedianInWindow(team: HistoricalTeam, startHour: number, endHour: number): number | null {
  return median(durationsInWindow(team, startHour, endHour));
}

function lapCountInWindow(team: HistoricalTeam, startHour: number, endHour: number): number {
  return team.cumulativeLapTimesMs.filter((timestampMs) => {
    const raceHour = timestampMs / 3_600_000;
    return raceHour >= startHour && raceHour < endHour;
  }).length;
}

function trimmedCumulativeSeconds(team: HistoricalTeam): number[] {
  const cumulativeSeconds = team.cumulativeLapTimesMs.map((timestampMs) => timestampMs / 1_000);
  if (cumulativeSeconds.length < 6) return cumulativeSeconds;
  const lastLapSeconds =
    cumulativeSeconds[cumulativeSeconds.length - 1] - cumulativeSeconds[cumulativeSeconds.length - 2];
  const medianEarlierSeconds = median(team.lapDurationsMs.slice(0, -1).map((durationMs) => durationMs / 1_000));
  return medianEarlierSeconds != null && lastLapSeconds > medianEarlierSeconds * 2.5
    ? cumulativeSeconds.slice(0, -1)
    : cumulativeSeconds;
}

function interpolatedProgress(cumulativeSeconds: number[], timestampSeconds: number): number {
  const nextLapIndex = upperBound(cumulativeSeconds, timestampSeconds);
  if (nextLapIndex === 0) return timestampSeconds / cumulativeSeconds[0];
  if (nextLapIndex >= cumulativeSeconds.length) {
    const recentPace = median(recentDurations(cumulativeSeconds, 20)) ?? 1;
    return cumulativeSeconds.length + (timestampSeconds - cumulativeSeconds[cumulativeSeconds.length - 1]) / recentPace;
  }
  const previousTimestamp = cumulativeSeconds[nextLapIndex - 1];
  const nextTimestamp = cumulativeSeconds[nextLapIndex];
  return nextLapIndex + (timestampSeconds - previousTimestamp) / (nextTimestamp - previousTimestamp);
}

function interpolatedTimestamp(cumulativeSeconds: number[], progress: number): number {
  if (progress <= 0) return 0;
  const completedLaps = Math.floor(progress);
  const lapFraction = progress - completedLaps;
  if (completedLaps >= cumulativeSeconds.length) {
    const recentPace = median(recentDurations(cumulativeSeconds, 20)) ?? 1;
    return cumulativeSeconds[cumulativeSeconds.length - 1] + (progress - cumulativeSeconds.length) * recentPace;
  }
  const previousTimestamp = completedLaps === 0 ? 0 : cumulativeSeconds[completedLaps - 1];
  const nextTimestamp = cumulativeSeconds[completedLaps];
  return previousTimestamp + lapFraction * (nextTimestamp - previousTimestamp);
}

function interpolateCurveTimestamp(
  curve: Array<{ timestampSeconds: number; progress: number }>,
  progress: number
): number {
  if (progress <= 0) return 0;
  const nextIndex = curve.findIndex((point) => point.progress >= progress);
  if (nextIndex === 0) return curve[0].timestampSeconds;
  if (nextIndex < 0) {
    const lastPoint = curve[curve.length - 1];
    const previousPoint = curve[Math.max(0, curve.length - 2)];
    const paceSeconds =
      (lastPoint.timestampSeconds - previousPoint.timestampSeconds) /
      Math.max(0.001, lastPoint.progress - previousPoint.progress);
    return lastPoint.timestampSeconds + (progress - lastPoint.progress) * paceSeconds;
  }
  const previousPoint = curve[nextIndex - 1];
  const nextPoint = curve[nextIndex];
  const fraction = (progress - previousPoint.progress) / Math.max(0.001, nextPoint.progress - previousPoint.progress);
  return previousPoint.timestampSeconds + fraction * (nextPoint.timestampSeconds - previousPoint.timestampSeconds);
}

function recentDurations(cumulativeSeconds: number[], count: number): number[] {
  return cumulativeSeconds
    .map((timestamp, index) => (index === 0 ? timestamp : timestamp - cumulativeSeconds[index - 1]))
    .slice(-count);
}

function cleanDraftingLaps(
  team: HistoricalTeam,
  options: { startHour: number; endHour: number; minimumLapSeconds: number; maximumLapSeconds: number }
): { timestampsSeconds: number[]; durationsSeconds: number[] } {
  const candidates = team.lapDurationsMs
    .map((durationMs, lapIndex) => ({
      timestampSeconds: team.cumulativeLapTimesMs[lapIndex] / 1_000,
      raceHour: team.cumulativeLapTimesMs[lapIndex] / 3_600_000,
      durationSeconds: durationMs / 1_000,
    }))
    .filter((lap) => lap.raceHour >= options.startHour && lap.raceHour <= options.endHour);
  const durations = candidates.map((lap) => lap.durationSeconds);
  const center = median(durations) ?? 0;
  const q1 = quantile(durations, 0.25) ?? center;
  const q3 = quantile(durations, 0.75) ?? center;
  const interquartileRange = q3 - q1;
  const medianAbsoluteDeviation = 1.4826 * (median(durations.map((duration) => Math.abs(duration - center))) ?? 0);
  const deviationLowerBound =
    medianAbsoluteDeviation > 0 ? center - 4 * medianAbsoluteDeviation : Number.NEGATIVE_INFINITY;
  const deviationUpperBound =
    medianAbsoluteDeviation > 0 ? center + 4 * medianAbsoluteDeviation : Number.POSITIVE_INFINITY;
  const lowerBound = Math.max(q1 - 3 * interquartileRange, deviationLowerBound, options.minimumLapSeconds);
  const upperBound = Math.min(q3 + 3 * interquartileRange, deviationUpperBound, options.maximumLapSeconds);
  const cleanLaps = candidates.filter((lap) => lap.durationSeconds >= lowerBound && lap.durationSeconds <= upperBound);
  return {
    timestampsSeconds: cleanLaps.map((lap) => lap.timestampSeconds),
    durationsSeconds: cleanLaps.map((lap) => lap.durationSeconds),
  };
}

function nearestSignedGap(focusTimestamp: number, otherTimestamps: number[]): number {
  if (!otherTimestamps.length) return Number.NaN;
  const insertionIndex = upperBound(otherTimestamps, focusTimestamp);
  const previousGap =
    insertionIndex > 0 ? focusTimestamp - otherTimestamps[insertionIndex - 1] : Number.POSITIVE_INFINITY;
  const nextGap =
    insertionIndex < otherTimestamps.length
      ? focusTimestamp - otherTimestamps[insertionIndex]
      : Number.POSITIVE_INFINITY;
  return Math.abs(previousGap) <= Math.abs(nextGap) ? previousGap : nextGap;
}

function compareGroups(label: string, firstValues: number[], secondValues: number[]): GroupComparison {
  const firstMedianSeconds = median(firstValues);
  const secondMedianSeconds = median(secondValues);
  return {
    label,
    firstCount: firstValues.length,
    secondCount: secondValues.length,
    firstMedianSeconds,
    secondMedianSeconds,
    effectSeconds:
      firstMedianSeconds == null || secondMedianSeconds == null ? null : secondMedianSeconds - firstMedianSeconds,
    pValue: mannWhitneyPValue(firstValues, secondValues),
  };
}

function mannWhitneyPValue(firstValues: number[], secondValues: number[]): number | null {
  if (!firstValues.length || !secondValues.length) return null;
  const combined = [
    ...firstValues.map((value) => ({ value, group: 0 })),
    ...secondValues.map((value) => ({ value, group: 1 })),
  ].sort((firstValue, secondValue) => firstValue.value - secondValue.value);
  const ranks: number[] = Array.from({ length: combined.length }, () => 0);
  let tieCorrection = 0;
  for (let startIndex = 0; startIndex < combined.length;) {
    let endIndex = startIndex + 1;
    while (endIndex < combined.length && combined[endIndex].value === combined[startIndex].value) endIndex += 1;
    const averageRank = (startIndex + 1 + endIndex) / 2;
    for (let rankIndex = startIndex; rankIndex < endIndex; rankIndex += 1) ranks[rankIndex] = averageRank;
    const tieCount = endIndex - startIndex;
    tieCorrection += tieCount ** 3 - tieCount;
    startIndex = endIndex;
  }
  const firstCount = firstValues.length;
  const secondCount = secondValues.length;
  const rankSum = combined.reduce((sum, entry, index) => sum + (entry.group === 0 ? ranks[index] : 0), 0);
  const uStatistic = rankSum - (firstCount * (firstCount + 1)) / 2;
  const totalCount = firstCount + secondCount;
  const variance =
    ((firstCount * secondCount) / (totalCount * (totalCount - 1))) *
    ((totalCount ** 3 - totalCount - tieCorrection) / 12);
  if (variance <= 0) return 1;
  const zScore = (uStatistic - (firstCount * secondCount) / 2) / Math.sqrt(variance);
  return clamp(2 * (1 - normalCdf(Math.abs(zScore))), 0, 1);
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const absoluteValue = Math.abs(value);
  const coefficient = 0.3275911;
  const transform = 1 / (1 + coefficient * absoluteValue);
  const polynomial =
    ((((1.061405429 * transform - 1.453152027) * transform + 1.421413741) * transform - 0.284496736) * transform +
      0.254829592) *
    transform;
  return sign * (1 - polynomial * Math.exp(-absoluteValue * absoluteValue));
}

function quantile(values: number[], probability: number): number | null {
  const sortedValues = values.filter(Number.isFinite).sort((firstValue, secondValue) => firstValue - secondValue);
  if (!sortedValues.length) return null;
  const position = clamp(probability, 0, 1) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const fraction = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - fraction) + sortedValues[upperIndex] * fraction;
}

function median(values: number[]): number | null {
  return quantile(values, 0.5);
}

function mean(values: number[]): number | null {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length : null;
}

function standardDeviation(values: number[]): number {
  const average = mean(values);
  if (average == null) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function upperBound(sortedValues: number[], maximumValue: number): number {
  let lowerIndex = 0;
  let upperIndex = sortedValues.length;
  while (lowerIndex < upperIndex) {
    const middleIndex = Math.floor((lowerIndex + upperIndex) / 2);
    if (sortedValues[middleIndex] <= maximumValue) lowerIndex = middleIndex + 1;
    else upperIndex = middleIndex;
  }
  return lowerIndex;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
