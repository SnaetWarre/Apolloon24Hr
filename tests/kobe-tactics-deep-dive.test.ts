import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTargetPaces, parseHistoricalRace } from '../src/lib/tactics';
import {
  analyzeDrafting,
  buildBreakEvenSensitivity,
  buildHourlyLapGains,
  buildLiveQuarterHourTrend,
  buildLiveRivalTimeGap,
  buildQuarterHourPaces,
  buildRaceLeadCurve,
  buildTimeGapCurve,
  calculateBreakEven,
  calculateNightPenalty,
  findPaceChanges,
  findSlowLaps,
  projectScenarioRange,
  smoothPacePoints,
  summarizeHistoricalTeams,
  summarizeHistoricalWindow,
} from '../src/lib/tacticsDeepDive';
import type { LapRecord } from '../src/types';

const race = parseHistoricalRace(JSON.stringify([
  { teamId: 1, lapTimes: cumulativeTimes([80, 80, 82, 81, 120, 82, 84, 86, 88, 90]) },
  { teamId: 4, lapTimes: cumulativeTimes([78, 79, 80, 82, 83, 84, 85, 86, 87, 88, 89]) },
]));
const firstTeam = race.teams[0];
const secondTeam = race.teams[1];

test('deep-dive summaries rank every team and retain distribution statistics', () => {
  const summaries = summarizeHistoricalTeams(race);

  assert.deepEqual(summaries.map((summary) => summary.teamId), [4, 1]);
  assert.equal(summaries[0].laps, 11);
  assert.ok(summaries[0].p10Seconds <= summaries[0].medianSeconds);
  assert.ok(summaries[0].p90Seconds >= summaries[0].medianSeconds);
});

test('tempo deep dive provides quarter detail and configurable night penalty', () => {
  const points = buildQuarterHourPaces(firstTeam, secondTeam, 0, 1);
  const smoothedPoints = smoothPacePoints(points, 3);
  const distribution = summarizeHistoricalWindow(firstTeam, 0, 1);
  const penalty = calculateNightPenalty(firstTeam, 0, 0.1);

  assert.equal(points.length, 4);
  assert.equal(smoothedPoints.length, points.length);
  assert.equal(distribution.laps, firstTeam.lapDurationsMs.length);
  assert.ok(distribution.interquartileRangeSeconds != null);
  assert.ok(points.some((point) => point.firstSeconds != null));
  assert.ok(penalty.nightMedianSeconds != null);
  assert.ok(penalty.dayMedianSeconds != null);
});

test('race deep dive preserves time-gap sign and hourly gain totals', () => {
  const timeGap = buildTimeGapCurve(firstTeam, secondTeam, 5);
  const hourlyGains = buildHourlyLapGains(firstTeam, secondTeam);
  const raceLead = buildRaceLeadCurve(firstTeam, secondTeam, 5);

  assert.equal(timeGap[0].gapSeconds, 0);
  assert.ok(timeGap.some((point) => point.gapSeconds > 0));
  assert.equal(hourlyGains.reduce((sum, point) => sum + point.lapDifference, 0), 1);
  assert.equal(raceLead[0].lapDifference, 0);
  assert.ok(raceLead.some((point) => point.lapDifference !== 0));
});

test('diagnostics find slow laps, pace changes, and a break-even pace', () => {
  const slowLaps = findSlowLaps(firstTeam, 100);
  const paceChanges = findPaceChanges(firstTeam, 8, 3);
  const breakEven = calculateBreakEven(firstTeam, secondTeam);
  const sensitivity = buildBreakEvenSensitivity(firstTeam, 10);

  assert.deepEqual(slowLaps.map((lap) => lap.durationSeconds), [120]);
  assert.ok(paceChanges.some((lap) => lap.durationSeconds === 120));
  assert.ok(breakEven);
  assert.equal(breakEven.targetLaps, 11);
  assert.ok(sensitivity.length > 10);
});

test('drafting analysis groups cleaned passages and reports all four comparisons', () => {
  const analysis = analyzeDrafting(firstTeam, secondTeam, {
    startHour: 0,
    endHour: 24,
    closeSeconds: 8,
    farSeconds: 15,
    minimumLapSeconds: 55,
    maximumLapSeconds: 140,
  });

  assert.equal(analysis.teamId, 1);
  assert.equal(analysis.signedGapSeconds.length, analysis.lapDurationsSeconds.length);
  assert.equal(analysis.proximityBins.length, 6);
  assert.equal(analysis.comparisons.length, 4);
});

test('live deep dive combines API laps with reference trends and scenario forecasts', () => {
  const raceStartedAt = 1_000_000;
  const liveLaps = [
    lap('one', raceStartedAt + 80_000, 80_000),
    lap('two', raceStartedAt + 161_000, 81_000),
    lap('three', raceStartedAt + 243_000, 82_000),
  ];
  const targetPaces = buildTargetPaces(1_000, firstTeam);
  const trend = buildLiveQuarterHourTrend(liveLaps, raceStartedAt, 0.1, firstTeam, secondTeam);
  const gap = buildLiveRivalTimeGap(liveLaps, raceStartedAt, 0.1, targetPaces, secondTeam);
  const range = projectScenarioRange(liveLaps.length, 0.1, targetPaces, 5);

  assert.equal(trend.length, 96);
  assert.ok(trend[0].liveSeconds != null);
  assert.ok(gap.some((point) => point.predicted));
  assert.ok(range.optimisticLaps > range.expectedLaps);
  assert.ok(range.expectedLaps > range.pessimisticLaps);
});

function cumulativeTimes(durationsSeconds: number[]): number[] {
  let elapsedMs = 0;
  return durationsSeconds.map((durationSeconds) => {
    elapsedMs += durationSeconds * 1_000;
    return elapsedMs;
  });
}

function lap(id: string, finishedAt: number, durationMs: number): LapRecord {
  return {
    id,
    runnerId: `runner-${id}`,
    runnerNumber: null,
    runnerName: id,
    lapNumber: 1,
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source: 'timing',
    createdAt: finishedAt,
    labels: [],
  };
}
