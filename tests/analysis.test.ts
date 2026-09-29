import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRollingLapTrend, buildTimeBuckets } from '../src/lib/analysis.ts';
import type { LapRecord, RaceState } from '../src/types.ts';

test('analysis hour buckets use Brussels clock hours from the race start', () => {
  const raceStartedAt = Date.parse('2026-10-20T20:00:00+02:00');
  const race = {
    id: 1,
    activeRunnerId: null,
    activeStartedAt: null,
    raceStartedAt,
    raceFinishedAt: null,
    activeLabels: [],
  } satisfies RaceState;
  const lap = (id: string, finishedAt: number): LapRecord => ({
    id,
    runnerId: 'runner-1',
    runnerName: 'Runner',
    runnerNumber: '1',
    lapNumber: 1,
    startedAt: finishedAt - 60_000,
    finishedAt,
    durationMs: 60_000,
    source: 'test',
    createdAt: finishedAt,
    labels: [],
  });

  const buckets = buildTimeBuckets(
    [
      lap('lap-1', raceStartedAt + 30 * 60_000),
      lap('lap-2', raceStartedAt + 3.5 * 3_600_000),
      lap('lap-3', raceStartedAt + 4.5 * 3_600_000),
    ],
    race
  );

  assert.deepEqual(
    buckets.map((bucket) => bucket.label),
    ['20u-21u', '23u-00u', '00u-01u']
  );
});

test('rolling analysis keeps exact window semantics with a linear sliding window', () => {
  const raceStartedAt = 1_000_000;
  const race = {
    id: 1,
    activeRunnerId: null,
    activeStartedAt: null,
    raceStartedAt,
    raceFinishedAt: null,
    activeLabels: [],
  } satisfies RaceState;
  const lap = (id: string, finishedAt: number, durationMs: number): LapRecord => ({
    id,
    runnerId: 'runner-1',
    runnerName: 'Runner',
    runnerNumber: '1',
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source: 'handoff',
    createdAt: finishedAt,
    labels: [],
    lapNumber: 1,
  });
  const laps = [
    lap('lap-4', raceStartedAt + 121_000, 80_000),
    lap('lap-2', raceStartedAt + 60_000, 70_000),
    lap('lap-1', raceStartedAt, 60_000),
    lap('lap-3', raceStartedAt + 60_000, 90_000),
  ];

  const points = buildRollingLapTrend(laps, race, 1);
  assert.deepEqual(
    points.map((point) => ({ averageMs: point.averageMs, count: point.count })),
    [
      { averageMs: 60_000, count: 1 },
      { averageMs: 73_333, count: 3 },
      { averageMs: 73_333, count: 3 },
      { averageMs: 80_000, count: 1 },
    ]
  );
});
