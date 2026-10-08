import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewLaps } from '../src/lib/lapReview.ts';

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
