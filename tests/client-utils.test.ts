import assert from 'node:assert/strict';
import test from 'node:test';
import { observeDisplayHistory } from '../src/lib/displayHistory.ts';
import {
  LIVE_MILLISECOND_INTERVAL_MS,
  normalizeClockInterval,
  SECOND_DISPLAY_INTERVAL_MS,
} from '../src/lib/useClockTick.ts';
import { createArrivalState, trackArrivals } from '../src/lib/motion.ts';
import { decodeCsvBytes } from '../src/lib/registrationFile.ts';
import { relativeFileWithinRoot } from '../server/static-files.ts';
import path from 'node:path';

test('live clocks are cadence-limited instead of driving full-frame renders', () => {
  assert.equal(normalizeClockInterval(0), 16);
  assert.equal(normalizeClockInterval(16), 16);
  assert.equal(normalizeClockInterval(LIVE_MILLISECOND_INTERVAL_MS), 33);
  assert.equal(SECOND_DISPLAY_INTERVAL_MS, 500);
  assert.equal(normalizeClockInterval(100), 100);
  assert.equal(normalizeClockInterval(Number.NaN), 1_000);
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
