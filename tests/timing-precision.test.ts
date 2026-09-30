import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('timing-precision');
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';

test('the cluster clock follows the fastest round trip and ignores noise', async () => {
  const clock = await import('../server/clock.ts');
  clock.setClusterClockOffset(0);
  clock.resetClockSamples();
  // The other laptop's clock is 1_500 ms ahead; a slow sample is skewed by its long round trip.
  assert.equal(clock.observeReferenceClock(10_000 + 1_500 + 40, 10_000, 10_080), true);
  assert.equal(clock.clusterClockOffset(), 1_500);
  assert.equal(clock.observeReferenceClock(20_000 + 1_500 + 1, 20_000, 20_002), false, 'within noise');
  assert.equal(clock.observeReferenceClock(30_000 + 1_490 + 150, 30_000, 30_300), false, 'slower than the best');
  assert.equal(clock.clusterClockOffset(), 1_500);
  clock.resetClockSamples();
  clock.setClusterClockOffset(0);
});

test('a press is timed from its input event and measures the lap on one monotonic clock', async () => {
  const { timePress, rememberLapStart } = await import('../src/lib/pressTiming.ts');
  const now = performance.now();
  const first = timePress(now - 20, null);
  assert.ok(Math.abs(first.pressedAt - (Date.now() - 20)) <= 2, 'the press is dated back to the key event');
  assert.equal(first.measuredDurationMs, undefined);

  rememberLapStart(first, now - 20);
  const second = timePress(now - 5, first.pressedAt);
  assert.equal(second.measuredDurationMs, 15);
  assert.equal(timePress(now, first.pressedAt + 1).measuredDurationMs, undefined, 'another lap is running');
});

test('the server takes the press moment and the measured lap, within sane bounds', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  const { appRouter } = await import('../server/router.ts');
  await db.initDb();
  try {
    const caller = appRouter.createCaller({});
    const first = db.insertRunner({ name: 'First', runnerNumber: '1', status: 'waiting' });
    const second = db.insertRunner({ name: 'Second', runnerNumber: '2', status: 'waiting' });
    db.insertRunner({ name: 'Third', runnerNumber: '3', status: 'waiting' });

    const startedAt = Date.now() - 5_000;
    await caller.race.startNext({ activeRunnerId: null, activeStartedAt: null, pressedAt: startedAt });
    assert.equal(db.getRaceState().activeStartedAt, startedAt, 'the lap starts at the key press');

    const finishedAt = startedAt + 4_000;
    await caller.race.handoff({
      activeRunnerId: first.id,
      activeStartedAt: startedAt,
      pressedAt: finishedAt,
      measuredDurationMs: 4_003,
    });
    const lap = db.getAllLaps()[0]!;
    assert.equal(lap.finishedAt, finishedAt);
    assert.equal(lap.durationMs, 4_003, 'the monotonic measurement wins over the clock difference');

    await caller.race.handoff({
      activeRunnerId: second.id,
      activeStartedAt: finishedAt,
      pressedAt: Date.now() - 60_000,
      measuredDurationMs: 1,
    });
    const implausible = db.getAllLaps()[0]!;
    assert.ok(Math.abs(implausible.finishedAt - Date.now()) < 1_000, 'a press far from this clock uses arrival time');
    assert.equal(implausible.durationMs, implausible.finishedAt - finishedAt, 'a measurement far off is ignored');
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
