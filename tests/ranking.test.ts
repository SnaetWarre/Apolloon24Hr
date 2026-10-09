import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRecentLapSummaries,
  buildRunnerRanking,
  calculateLapCoefficient,
  calculateLapPoints,
} from '../src/lib/ranking.ts';
import type { Label, LapRecord, Runner } from '../src/types.ts';

test('lap coefficients use the 85-second reference and 0.075 points per second', () => {
  const examples = [
    [65_000, 2.5],
    [68_200, 2.26],
    [78_400, 1.495],
    [84_300, 1.0525],
    [85_000, 1],
    [85_600, 1],
    [87_400, 1],
    [89_000, 1],
    [90_000, 1],
    [100_000, 1],
  ] as const;

  for (const [durationMs, expectedCoefficient] of examples) {
    assert.ok(Math.abs(calculateLapCoefficient(durationMs) - expectedCoefficient) < 1e-10);
  }
});

test('lap points use the finishing time in Brussels across all six four-hour blocks', () => {
  const examples = [
    ['2026-09-23T22:00:00Z', 1.25], // 00:00 in Brussels
    ['2026-09-24T02:00:00Z', 1.5], // 04:00
    ['2026-09-24T06:00:00Z', 1.5], // 08:00
    ['2026-09-24T10:00:00Z', 1.25], // 12:00
    ['2026-09-24T14:00:00Z', 1], // 16:00
    ['2026-09-24T18:00:00Z', 1], // 20:00
    ['2026-09-24T21:59:59Z', 1], // 23:59
  ] as const;

  for (const [finishedAt, expectedPoints] of examples) {
    assert.equal(
      calculateLapPoints({ source: 'handoff', durationMs: 85_000, finishedAt: Date.parse(finishedAt) }),
      expectedPoints
    );
  }
  assert.equal(
    calculateLapPoints({ source: 'handoff', durationMs: 80_000, finishedAt: Date.parse(examples[0][0]) }),
    1.71875
  );
  assert.equal(calculateLapPoints({ source: 'handoff', durationMs: 85_000, finishedAt: Number.NaN }), 0);
  assert.equal(
    calculateLapPoints({ source: 'handoff', durationMs: 100_000, finishedAt: Date.parse(examples[0][0]) }),
    1.25
  );
});

test('lap points follow Brussels daylight saving time', () => {
  assert.equal(
    calculateLapPoints({ source: 'handoff', durationMs: 85_000, finishedAt: Date.parse('2026-10-25T02:00:00Z') }),
    1.25
  );
  assert.equal(
    calculateLapPoints({ source: 'handoff', durationMs: 85_000, finishedAt: Date.parse('2026-10-25T03:00:00Z') }),
    1.5
  );
});

test('lap points match the example totals in coeff_berekeningen.xlsx', () => {
  const points = (finishedAt: string) =>
    calculateLapPoints({
      source: 'handoff',
      durationMs: 80_000,
      finishedAt: Date.parse(finishedAt),
    });

  assert.equal(points('2026-09-23T18:00:00Z') + points('2026-09-23T22:00:00Z'), 3.09375);
  assert.equal(
    points('2026-09-24T02:00:00Z') + points('2026-09-24T06:00:00Z') + points('2026-09-24T10:00:00Z'),
    5.84375
  );
  assert.equal(points('2026-09-24T14:00:00Z'), 1.375);
});

test('inside rankings switch metric and filter laps by their historical label', () => {
  const firstYearsLabel = {
    id: 'first-years',
    name: 'Eerstejaars',
    color: '#2877F6',
    icon: 'E',
    kind: 'custom',
    imageUrl: null,
    targetLaps: null,
    sortOrder: 1,
  } satisfies Label;
  const runners = [
    { id: 'steady', name: 'Steady', runnerNumber: '1' },
    { id: 'fast', name: 'Fast', runnerNumber: '2' },
  ] as Runner[];
  const lap = (id: string, runnerId: string, durationMs: number, labels: Label[]): LapRecord => ({
    id,
    runnerId,
    runnerName: runnerId === 'steady' ? 'Steady' : 'Fast',
    runnerNumber: runnerId === 'steady' ? '1' : '2',
    lapNumber: 1,
    startedAt: 1_000,
    finishedAt: 1_000 + durationMs,
    durationMs,
    source: 'handoff',
    createdAt: 1_000 + durationMs,
    labels,
  });
  const laps = [
    lap('steady-1', 'steady', 89_000, [firstYearsLabel]),
    lap('steady-2', 'steady', 89_000, [firstYearsLabel]),
    lap('fast-1', 'fast', 65_000, [firstYearsLabel]),
    lap('fast-other-label', 'fast', 65_000, []),
  ];

  assert.deepEqual(
    buildRunnerRanking(runners, laps, 'laps', firstYearsLabel.id).map((entry) => entry.runnerId),
    ['steady', 'fast']
  );
  assert.deepEqual(
    buildRunnerRanking(runners, laps, 'coefficient', firstYearsLabel.id).map((entry) => entry.runnerId),
    ['fast', 'steady']
  );
  assert.equal(buildRunnerRanking(runners, laps, 'coefficient', null)[0]?.coefficientTotal, 6.25);
});

test('a double press and a split half earn the base point but no speed bonus', () => {
  const finishedAt = Date.parse('2026-09-24T14:00:00Z'); // 16:00 in Brussels, factor 1
  const lap = (id: string, durationMs: number, source: LapRecord['source']): LapRecord => ({
    id,
    runnerId: 'runner',
    runnerName: 'Runner',
    runnerNumber: '1',
    lapNumber: 1,
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source,
    createdAt: finishedAt,
    labels: [],
  });

  assert.equal(calculateLapPoints(lap('double-press', 1_300, 'handoff')), 1);
  assert.equal(calculateLapPoints(lap('split-half', 40_000, 'split')), 1);
  assert.equal(calculateLapPoints(lap('real', 60_000, 'handoff')), 2.875);
  assert.equal(
    buildRunnerRanking(
      [],
      [lap('double-press', 1_300, 'handoff'), lap('split-half', 40_000, 'split')],
      'coefficient',
      null
    )[0]?.coefficientTotal,
    2
  );
});

test('the three recent laps show each runners all-time best and average', () => {
  const lap = (id: string, runnerId: string, durationMs: number, finishedAt: number): LapRecord => ({
    id,
    runnerId,
    runnerName: runnerId,
    runnerNumber: null,
    lapNumber: 1,
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source: 'handoff',
    createdAt: finishedAt,
    labels: [],
  });
  const summaries = buildRecentLapSummaries([
    lap('older-a', 'runner-a', 90_000, 1_000),
    lap('recent-a', 'runner-a', 70_000, 4_000),
    lap('recent-b', 'runner-b', 80_000, 3_000),
    lap('recent-c', 'runner-c', 85_000, 2_000),
  ]);

  assert.deepEqual(
    summaries.map((summary) => summary.lap.id),
    ['recent-a', 'recent-b', 'recent-c']
  );
  assert.equal(summaries[0]?.bestLapMs, 70_000);
  assert.equal(summaries[0]?.averageLapMs, 80_000);
});

test('a lap where nobody handed off still counts but stays out of the averages', () => {
  const runners = [
    { id: 'anna', name: 'Anna', runnerNumber: '1' },
    { id: 'bert', name: 'Bert', runnerNumber: '2' },
    { id: 'cas', name: 'Cas', runnerNumber: '3' },
  ] as Runner[];
  const lap = (id: string, runnerId: string, durationMs: number, finishedAt: number): LapRecord => ({
    id,
    runnerId,
    runnerName: runnerId,
    runnerNumber: null,
    lapNumber: 1,
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source: 'handoff',
    createdAt: finishedAt,
    labels: [],
  });
  const annaAndBert = [
    lap('anna-1', 'anna', 90_000, 1_000),
    lap('anna-idle', 'anna', 25 * 60_000, 2_000),
    lap('anna-3', 'anna', 90_000, 3_000),
    lap('bert-1', 'bert', 95_000, 1_100),
    lap('bert-2', 'bert', 95_000, 2_100),
    lap('bert-3', 'bert', 95_000, 3_100),
  ];

  const ranking = buildRunnerRanking(runners, annaAndBert, 'laps', null);
  assert.deepEqual(
    ranking.map((entry) => [entry.runnerId, entry.lapCount, entry.averageLapMs]),
    [
      ['anna', 3, 90_000],
      ['bert', 3, 95_000],
    ]
  );

  const [annaSummary] = buildRecentLapSummaries([...annaAndBert, lap('anna-4', 'anna', 90_000, 4_000)], 1);
  assert.equal(annaSummary?.lap.id, 'anna-4');
  assert.equal(annaSummary?.bestLapMs, 90_000);
  assert.equal(annaSummary?.averageLapMs, 90_000);

  // Cas only has idle laps: no average, so he sorts after Anna on the tie-break.
  const withCas = [
    ...annaAndBert,
    lap('cas-1', 'cas', 15 * 60_000, 1_200),
    lap('cas-2', 'cas', 15 * 60_000, 2_200),
    lap('cas-3', 'cas', 15 * 60_000, 5_000),
  ];
  const casRanking = buildRunnerRanking(runners, withCas, 'laps', null);
  assert.deepEqual(
    casRanking.map((entry) => entry.runnerId),
    ['anna', 'bert', 'cas']
  );
  assert.equal(casRanking[2]?.lapCount, 3);
  assert.equal(casRanking[2]?.averageLapMs, null);

  const [casSummary] = buildRecentLapSummaries(withCas, 1);
  assert.equal(casSummary?.lap.id, 'cas-3');
  assert.equal(casSummary?.bestLapMs, null);
  assert.equal(casSummary?.averageLapMs, null);
});

test('a double press still counts as a lap but not as a lap time', () => {
  const runners = [
    { id: 'anna', name: 'Anna', runnerNumber: '1' },
    { id: 'bert', name: 'Bert', runnerNumber: '2' },
  ] as Runner[];
  const lap = (id: string, runnerId: string, durationMs: number, finishedAt: number): LapRecord => ({
    id,
    runnerId,
    runnerName: runnerId,
    runnerNumber: null,
    lapNumber: 1,
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source: 'handoff',
    createdAt: finishedAt,
    labels: [],
  });
  const laps = [
    lap('anna-1', 'anna', 90_000, 1_000),
    lap('anna-2', 'anna', 80_000, 2_000),
    lap('anna-double', 'anna', 87, 3_000),
    lap('bert-double', 'bert', 19_999, 4_000),
  ];

  assert.deepEqual(
    buildRunnerRanking(runners, laps, 'laps', null).map((entry) => [
      entry.runnerId,
      entry.lapCount,
      entry.averageLapMs,
    ]),
    [
      ['anna', 3, 85_000],
      ['bert', 1, null],
    ]
  );

  const [bertSummary, annaSummary] = buildRecentLapSummaries(laps, 2);
  assert.equal(annaSummary?.lap.id, 'anna-double');
  assert.equal(annaSummary?.bestLapMs, 80_000);
  assert.equal(annaSummary?.averageLapMs, 85_000);
  assert.equal(bertSummary?.bestLapMs, null);
  assert.equal(bertSummary?.averageLapMs, null);
});
