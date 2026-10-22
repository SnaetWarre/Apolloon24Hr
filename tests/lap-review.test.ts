import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewHandoffs, reviewLaps } from '../src/lib/lapReview.ts';

const laps = (durations: number[]) => durations.map((durationMs, index) => ({ id: `lap-${index}`, durationMs }));

test('laps far below or above the race median are flagged as short or long', () => {
  const review = reviewLaps(laps([75_000, 78_000, 2_100, 80_000, 152_000, 76_000, 131_000, 79_000]));
  assert.equal(review.medianMs, 78_500);
  assert.deepEqual(Object.fromEntries(review.flags), { 'lap-2': 'short', 'lap-4': 'long' });
});

test('too few laps to know a usual lap flag nothing', () => {
  const review = reviewLaps(laps([2_000, 80_000, 160_000, 80_000]));
  assert.equal(review.medianMs, null);
  assert.equal(review.flags.size, 0);
});

/** Runners taking turns in `order`, each lap their usual time plus what `extra` adds at that lap. */
function relay(order: string[], usual: Record<string, number>, extra: Record<number, number> = {}) {
  let at = 0;
  return order.map((runnerId, index) => {
    const durationMs = usual[runnerId] + (extra[index] ?? 0);
    const lap = {
      id: `lap-${index}`,
      runnerId,
      startedAt: at,
      finishedAt: at + durationMs,
      durationMs,
      source: 'spacebar',
    };
    at += durationMs;
    return lap;
  });
}

const usual = { mitras: 79_500, wout: 74_400, thomas: 77_100, tibo: 70_300 };
const rounds = (count: number) => Array.from({ length: count }, () => ['mitras', 'wout', 'thomas', 'tibo']).flat();

test('a press 4 s late is found by the runners on both sides of it, as "Mitras −4, Wout +4"', () => {
  const hints = reviewHandoffs(relay(rounds(3), usual, { 8: 4_000, 9: -4_000 }));
  assert.deepEqual(Object.fromEntries(hints), {
    'lap-8': { shiftMs: -4_000, usualBeforeMs: 79_500, usualAfterMs: 74_400 },
  });
});

test('two late presses in a row are two hints, not a third early one between them', () => {
  const hints = reviewHandoffs(relay(rounds(3), usual, { 8: 4_000, 9: -4_000, 10: 4_000, 11: -4_000 }));
  assert.deepEqual([...hints.keys()], ['lap-8', 'lap-10']);
});

test('a slow lap on its own, or a runner with fewer than two other laps, is no late press', () => {
  assert.equal(reviewHandoffs(relay(rounds(3), usual, { 8: 6_000 })).size, 0);
  assert.equal(reviewHandoffs(relay(rounds(2), usual, { 4: 4_000, 5: -4_000 })).size, 0);
});
