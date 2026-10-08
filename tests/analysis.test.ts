import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFastestLapWindows,
  buildKpis,
  buildLabelComparisons,
  buildRollingLapTrend,
  buildRunnerInsights,
  buildTimeBuckets,
  filterLaps,
  isFastestLapForRecordMode,
  toggleLabelFilter,
} from '../src/lib/analysis.ts';
import type { Label, LapRecord, RaceState, Runner } from '../src/types.ts';

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

test('turning a label off and on again keeps laps without labels', () => {
  const label = (id: string): Label => ({
    id,
    name: id,
    color: '#000000',
    icon: 'tag',
    kind: 'team',
    imageUrl: null,
    targetLaps: null,
    sortOrder: null,
  });
  const lap = (id: string, labels: Label[]): LapRecord => ({
    id,
    runnerId: 'runner-1',
    runnerName: 'Runner',
    runnerNumber: '1',
    lapNumber: 1,
    startedAt: 0,
    finishedAt: 60_000,
    durationMs: 60_000,
    source: 'test',
    createdAt: 60_000,
    labels,
  });
  const blue = label('blue');
  const red = label('red');
  const allLabelIds = [blue.id, red.id];
  const laps = [lap('lap-blue', [blue]), lap('lap-red', [red]), lap('lap-unlabeled', [])];

  const blueOff = toggleLabelFilter({ enabledLabelIds: null }, blue.id, allLabelIds);
  assert.deepEqual(blueOff, { enabledLabelIds: [red.id] });
  assert.deepEqual(
    filterLaps(laps, blueOff).map((entry) => entry.id),
    ['lap-red']
  );

  const blueOn = toggleLabelFilter(blueOff, blue.id, allLabelIds);
  assert.deepEqual(blueOn, { enabledLabelIds: null });
  assert.deepEqual(
    filterLaps(laps, blueOn).map((entry) => entry.id),
    ['lap-blue', 'lap-red', 'lap-unlabeled']
  );

  const fromNone = toggleLabelFilter(
    toggleLabelFilter({ enabledLabelIds: [] }, red.id, allLabelIds),
    blue.id,
    allLabelIds
  );
  assert.deepEqual(fromNone, { enabledLabelIds: null });
});

test('a double press under 20 s never flashes as a record and is no record to beat', () => {
  const raceStartedAt = 1_000_000;
  const race = {
    id: 1,
    activeRunnerId: null,
    activeStartedAt: null,
    raceStartedAt,
    raceFinishedAt: null,
    activeLabels: [],
  } satisfies RaceState;
  let finishedAt = raceStartedAt;
  const lap = (id: string, durationMs: number): LapRecord => {
    finishedAt += durationMs;
    return {
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
    };
  };
  const realLaps = [lap('lap-1', 75_000), lap('lap-2', 62_000)];
  const doublePress = lap('lap-3', 9_000);
  const nextLap = lap('lap-4', 50_000);

  for (const mode of ['day', 'hour', 'two_hour'] as const) {
    assert.equal(isFastestLapForRecordMode(doublePress, realLaps, race, mode), false, mode);
    assert.equal(isFastestLapForRecordMode(nextLap, [doublePress, ...realLaps], race, mode), true, mode);
  }
});

test('a double press under 20 s stays out of the Analyse lap times', () => {
  const raceStartedAt = 1_000_000;
  const race = {
    id: 1,
    activeRunnerId: null,
    activeStartedAt: null,
    raceStartedAt,
    raceFinishedAt: null,
    activeLabels: [],
  } satisfies RaceState;
  let finishedAt = raceStartedAt;
  const lap = (id: string, durationMs: number): LapRecord => {
    finishedAt += durationMs;
    return {
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
    };
  };
  const laps = [lap('lap-1', 70_000), lap('lap-2', 90_000), lap('double', 87), lap('lap-4', 80_000)];

  const kpis = buildKpis(laps, race);
  assert.equal(kpis.count, 4);
  assert.equal(kpis.bestMs, 70_000);
  assert.equal(kpis.averageMs, 80_000);
  assert.equal(kpis.medianMs, 80_000);

  const [insight] = buildRunnerInsights([{ id: 'runner-1', name: 'Runner', runnerNumber: '1' }] as Runner[], laps);
  assert.equal(insight?.count, 4);
  assert.equal(insight?.bestMs, 70_000);
  assert.equal(insight?.averageMs, 80_000);

  const label: Label = {
    id: 'ploeg',
    name: 'Ploeg',
    color: '#000000',
    icon: 'tag',
    kind: 'team',
    imageUrl: null,
    targetLaps: null,
    sortOrder: null,
  };
  const [comparison] = buildLabelComparisons(
    [label],
    laps.map((lap) => ({ ...lap, labels: [label] }))
  );
  assert.equal(comparison?.count, 4);
  assert.equal(comparison?.bestMs, 70_000);

  assert.deepEqual(
    buildTimeBuckets(laps, race).map((bucket) => [bucket.count, bucket.averageMs]),
    [[4, 80_000]]
  );
  for (const mode of ['day', 'hour', 'two_hour'] as const) {
    assert.deepEqual(
      buildFastestLapWindows(laps, race, mode).map((window) => window.lap.id),
      ['lap-1'],
      mode
    );
  }
});

test('the guessed second half of a split lap never flashes as a record and is no record to beat', () => {
  const raceStartedAt = 1_000_000;
  const race = {
    id: 1,
    activeRunnerId: null,
    activeStartedAt: null,
    raceStartedAt,
    raceFinishedAt: null,
    activeLabels: [],
  } satisfies RaceState;
  let finishedAt = raceStartedAt;
  const lap = (id: string, durationMs: number, source = 'handoff'): LapRecord => {
    finishedAt += durationMs;
    return {
      id,
      runnerId: 'runner-1',
      runnerName: 'Runner',
      runnerNumber: '1',
      startedAt: finishedAt - durationMs,
      finishedAt,
      durationMs,
      source,
      createdAt: finishedAt,
      labels: [],
      lapNumber: 1,
    };
  };
  const realLaps = [lap('lap-1', 75_000), lap('lap-2', 63_000)];
  const splitHalf = lap('lap-3', 41_674, 'split');
  const nextLap = lap('lap-4', 50_000);

  for (const mode of ['day', 'hour', 'two_hour'] as const) {
    assert.equal(isFastestLapForRecordMode(splitHalf, realLaps, race, mode), false, mode);
    assert.equal(isFastestLapForRecordMode(nextLap, [splitHalf, ...realLaps], race, mode), true, mode);
  }
});
