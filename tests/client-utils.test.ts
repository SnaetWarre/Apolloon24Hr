import assert from 'node:assert/strict';
import test from 'node:test';
import { observeDisplayHistory } from '../src/lib/displayHistory.ts';
import {
  LIVE_MILLISECOND_INTERVAL_MS,
  msUntilNextTick,
  normalizeClockInterval,
  SECOND_DISPLAY_INTERVAL_MS,
} from '../src/lib/useClockTick.ts';
import { nowMs, onServerClockSync, syncServerClock } from '../src/lib/time.ts';
import { createArrivalState, trackArrivals } from '../src/lib/motion.ts';
import { decodeCsvBytes } from '../src/lib/registrationFile.ts';
import { getNextWaitingRunner } from '../src/lib/runners.ts';
import type { Runner } from '../src/types.ts';
import { relativeFileWithinRoot } from '../server/static-files.ts';
import { formatClockTimeMs } from '../shared/time.ts';
import { parseTeamWindow, toLocalDateTime } from '../src/components/admin/temporaryTeamTime.ts';
import path from 'node:path';

test('live clocks are cadence-limited instead of driving full-frame renders', () => {
  assert.equal(normalizeClockInterval(0), 16);
  assert.equal(normalizeClockInterval(16), 16);
  assert.equal(normalizeClockInterval(LIVE_MILLISECOND_INTERVAL_MS), 33);
  assert.equal(SECOND_DISPLAY_INTERVAL_MS, 500);
  assert.equal(normalizeClockInterval(100), 100);
  assert.equal(normalizeClockInterval(Number.NaN), 1_000);
});

test('clock ticks fall on the group clock hour, not on this laptop clock hour', async () => {
  const hourMs = 3_600_000;
  const laptopElevenMs = Date.parse('2026-10-06T11:00:00+02:00');

  // This laptop runs 5 s ahead: at its 11:00:00 the group clock still reads 10:59:55.
  assert.equal(msUntilNextTick(laptopElevenMs - 5_000, hourMs), 5_000);
  // This laptop runs 5 s behind: at its 11:00:00 the group clock already reads 11:00:05.
  assert.equal(msUntilNextTick(laptopElevenMs + 5_000, hourMs), hourMs - 5_000);
  assert.equal(msUntilNextTick(laptopElevenMs, hourMs), hourMs);

  // A sync that moves the group clock tells running clocks to reschedule; measurement noise does not.
  let syncs = 0;
  const stop = onServerClockSync(() => (syncs += 1));
  try {
    await syncServerClock(1, async () => Date.now() - 5_000);
    assert.equal(syncs, 1);
    assert.ok(Math.abs(nowMs() - (Date.now() - 5_000)) < 50);
    await syncServerClock(1, async () => Date.now() - 5_000);
    assert.equal(syncs, 1);
  } finally {
    stop();
    await syncServerClock(1, async () => Date.now());
  }
  assert.equal(syncs, 1);
});

test('the outside display announces only history that is new since it opened', () => {
  assert.equal(observeDisplayHistory(false, null, [], null), null);

  const initialHistory = observeDisplayHistory(true, null, ['existing-event'], 'existing-event');
  assert.ok(initialHistory);
  assert.equal(initialHistory.shouldAnnounceLatest, false);
  assert.deepEqual([...initialHistory.knownIds], ['existing-event']);

  const unchangedHistory = observeDisplayHistory(true, initialHistory.knownIds, ['existing-event'], 'existing-event');
  assert.ok(unchangedHistory);
  assert.equal(unchangedHistory.shouldAnnounceLatest, false);

  const realtimeHistory = observeDisplayHistory(
    true,
    unchangedHistory.knownIds,
    ['new-event', 'existing-event'],
    'new-event'
  );
  assert.ok(realtimeHistory);
  assert.equal(realtimeHistory.shouldAnnounceLatest, true);
});

test('only items that arrive after the first render with data count as new', () => {
  const state = createArrivalState();
  assert.deepEqual([...trackArrivals(state, ['a', 'b'], false, 1_000)], [], 'nothing is new while loading');
  assert.deepEqual([...trackArrivals(state, ['a', 'b'], true, 2_000)], [], 'the first data seeds silently');
  assert.deepEqual([...trackArrivals(state, ['c', 'a', 'b'], true, 3_000)], ['c'], 'a later item is new');
  assert.deepEqual([...trackArrivals(state, ['c', 'a', 'b'], true, 3_500)], ['c'], 'and stays new for a moment');
  assert.deepEqual([...trackArrivals(state, ['c', 'a', 'b'], true, 5_000)], [], 'then settles');
  assert.deepEqual([...trackArrivals(state, ['c', 'b'], true, 6_000)], [], 'leaving is silent');
  assert.deepEqual([...trackArrivals(state, ['a', 'c', 'b'], true, 7_000)], ['a'], 'coming back arrives again');

  const emptyStart = createArrivalState();
  assert.deepEqual([...trackArrivals(emptyStart, [], true, 1_000)], []);
  assert.deepEqual(
    [...trackArrivals(emptyStart, ['first'], true, 2_000)],
    ['first'],
    'the first lap of a race arrives'
  );
});

test('packaged static files stay relative to the AppImage mount root', () => {
  const hiddenMountRoot = path.join('/tmp', '.mount_LeuvenExample', 'resources', 'app.asar');
  const distRoot = path.join(hiddenMountRoot, 'dist');

  assert.equal(
    relativeFileWithinRoot(distRoot, path.join(distRoot, 'assets', 'app.js.br')),
    path.join('assets', 'app.js.br')
  );
  assert.equal(relativeFileWithinRoot(distRoot, path.join(distRoot, 'index.html')), 'index.html');
  assert.equal(relativeFileWithinRoot(distRoot, path.join(hiddenMountRoot, 'secret.txt')), null);
});

test('registration CSVs are read as UTF-8, or as Windows-1252 when Excel saved them that way', () => {
  const header = 'runner_number;naam\r\n';
  assert.equal(decodeCsvBytes(new TextEncoder().encode(`${header}901;Zoë Desmét\r\n`)), `${header}901;Zoë Desmét\r\n`);
  assert.equal(
    decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(`${header}902;François\r\n`)])),
    `${header}902;François\r\n`
  );
  const ansi = Uint8Array.from(`${header}901;Zo\xeb Desm\xe9t\r\n902;Fran\xe7ois L\xe9vesque\r\n`, (char) =>
    char.charCodeAt(0)
  );
  assert.equal(decodeCsvBytes(ansi), `${header}901;Zoë Desmét\r\n902;François Lévesque\r\n`);
});

test('the next runner breaks a shared queue place the way the server does', () => {
  const runner = (id: string, status: Runner['status'], queueIndex: number | null, statusSince: number) =>
    ({ id, status, queueIndex, statusSince }) as Runner;
  // The server lists runners by name and starts the one that joined first when two share a place.
  const runners = [
    runner('ann', 'waiting', 0, 2_500),
    runner('bob', 'running', null, 100),
    runner('zed', 'waiting', 0, 200),
    runner('cas', 'waiting', 1, 50),
  ];
  assert.equal(getNextWaitingRunner(runners)?.id, 'zed');
  assert.equal(getNextWaitingRunner(runners.filter((other) => other.id !== 'zed'))?.id, 'ann');
  assert.equal(getNextWaitingRunner([runners[1]]), null);
});

test('screens and night-team fields use Brussels time, even on a TV left on UTC', (t) => {
  // Act like a TV left on UTC, so these fail if anything falls back to this machine's own zone.
  const zone = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });
  const summerLap = Date.UTC(2026, 9, 8, 18, 35, 10, 42);
  const winterLap = Date.UTC(2026, 0, 8, 23, 5, 1, 7);
  assert.equal(formatClockTimeMs(summerLap), '20:35:10.042');
  assert.equal(formatClockTimeMs(winterLap), '00:05:01.007');

  assert.equal(toLocalDateTime(summerLap), '2026-10-08T20:35');
  assert.equal(toLocalDateTime(winterLap), '2026-01-09T00:05');
  // The night of 24 to 25 October 2026 has the 03:00 to 02:00 clock change.
  assert.deepEqual(parseTeamWindow('2026-10-24T22:00', '2026-10-25T06:00'), {
    startsAt: Date.UTC(2026, 9, 24, 20),
    endsAt: Date.UTC(2026, 9, 25, 5),
  });
});
