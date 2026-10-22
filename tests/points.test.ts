import assert from 'node:assert/strict';
import test from 'node:test';
import { lapDaypart, lapPoints, lapTimeCoefficient } from '../shared/points.ts';

const assertClose = (actual: number | undefined, expected: number) =>
  assert.ok(Math.abs((actual ?? Number.NaN) - expected) < 1e-9, `${actual} is not ${expected}`);

test('lap coefficients use the 85-second reference and 0.125 per second', () => {
  const examples = [
    [65_000, 3.5],
    [68_200, 3.1],
    [78_400, 1.825],
    [84_300, 1.0875],
    [85_000, 1],
    [85_600, 1],
    [87_400, 1],
    [89_000, 1],
    [90_000, 1],
    [100_000, 1],
  ] as const;

  for (const [durationMs, expectedCoefficient] of examples) {
    assertClose(lapTimeCoefficient(durationMs), expectedCoefficient);
  }
});

test('lap points use the starting time in Brussels across all six four-hour blocks', () => {
  const examples = [
    ['2026-09-23T22:00:00Z', 26], // 00:00 in Brussels
    ['2026-09-24T02:00:00Z', 36], // 04:00
    ['2026-09-24T06:00:00Z', 36], // 08:00
    ['2026-09-24T10:00:00Z', 26], // 12:00
    ['2026-09-24T14:00:00Z', 20], // 16:00
    ['2026-09-24T18:00:00Z', 20], // 20:00
    ['2026-09-24T21:59:59Z', 20], // 23:59
  ] as const;

  for (const [startedAt, expectedPoints] of examples) {
    assertClose(lapPoints({ source: 'handoff', durationMs: 85_000, startedAt: Date.parse(startedAt) }), expectedPoints);
  }
  assertClose(lapPoints({ source: 'handoff', durationMs: 80_000, startedAt: Date.parse(examples[0][0]) }), 42.25);
  assert.equal(lapPoints({ source: 'handoff', durationMs: 85_000, startedAt: Number.NaN }), 0);
  assertClose(lapPoints({ source: 'handoff', durationMs: 100_000, startedAt: Date.parse(examples[0][0]) }), 26);
});

test('lap points follow Brussels daylight saving time', () => {
  assertClose(lapPoints({ source: 'handoff', durationMs: 85_000, startedAt: Date.parse('2026-10-25T02:00:00Z') }), 26);
  assertClose(lapPoints({ source: 'handoff', durationMs: 85_000, startedAt: Date.parse('2026-10-25T03:00:00Z') }), 36);
});

test('lap points match the example totals in Prijzensysteem 2026.xlsx', () => {
  // Brussels clock hour in each four-hour block on a summer-time day (UTC+2).
  const startedAtByBlock = {
    '20-24u': '2026-10-13T18:30:00Z',
    '00-4u': '2026-10-13T23:00:00Z',
    '4-8u': '2026-10-14T03:00:00Z',
    '8-12u': '2026-10-14T07:00:00Z',
    '12-16u': '2026-10-14T11:00:00Z',
    '16-20u': '2026-10-14T15:00:00Z',
  } as const;
  const total = (laps: [seconds: number, block: keyof typeof startedAtByBlock][]) =>
    laps.reduce(
      (sum, [seconds, block]) =>
        sum +
        lapPoints({
          source: 'handoff',
          durationMs: seconds * 1_000,
          startedAt: Date.parse(startedAtByBlock[block]),
        }),
      0
    );

  // "10 rondes aan 1:17 (realistische speedteamer)"
  assertClose(
    total([
      [78, '20-24u'],
      [78, '20-24u'],
      [78, '20-24u'],
      [78, '20-24u'],
      [78, '00-4u'],
      [78, '8-12u'],
      [78, '8-12u'],
      [78, '16-20u'],
      [78, '16-20u'],
      [78, '16-20u'],
    ]),
    446.25
  );
  // "5 rondes aan 1:20 (nachtloper)"
  assertClose(
    total([
      [80, '00-4u'],
      [80, '4-8u'],
      [80, '4-8u'],
      [80, '4-8u'],
      [80, '4-8u'],
    ]),
    276.25
  );
  // "5 rondes met wisselende tijden"
  assertClose(
    total([
      [80, '4-8u'],
      [80, '8-12u'],
      [75, '8-12u'],
      [81, '8-12u'],
      [82, '8-12u'],
      [77, '12-16u'],
      [78, '12-16u'],
    ]),
    402.25
  );
});

test('a lap of exactly 85 s earns the base points, and a slower lap earns no less', () => {
  const startedAt = Date.parse('2026-10-20T15:00:00Z'); // 17:00 in Brussels, factor 1
  assert.equal(lapPoints({ source: 'handoff', durationMs: 85_000, startedAt }), 20);
  assert.equal(lapPoints({ source: 'handoff', durationMs: 96_480, startedAt }), 20);
  // The exact time counts, not rounded seconds: 84.917 s is 0.083 s under the reference.
  assertClose(lapPoints({ source: 'handoff', durationMs: 84_917, startedAt }), 20 * (1 + 0.125 * 0.083));
});

test('the daypart follows the hour a lap started, not the hour it finished', () => {
  // 01:59 and 02:00 UTC are 03:59 and 04:00 in Brussels summer time.
  const beforeFour = { source: 'handoff', durationMs: 85_000, startedAt: Date.parse('2026-10-21T01:59:59.999Z') };
  const atFour = { source: 'handoff', durationMs: 85_000, startedAt: Date.parse('2026-10-21T02:00:00.000Z') };
  assert.equal(lapDaypart(beforeFour.startedAt)?.name, '00-04u');
  assert.equal(lapDaypart(atFour.startedAt)?.name, '04-08u');
  assertClose(lapPoints(beforeFour), 26);
  assertClose(lapPoints(atFour), 36);
});
