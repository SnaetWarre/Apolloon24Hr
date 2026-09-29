import assert from 'node:assert/strict';
import test from 'node:test';
import { observeDisplayHistory } from '../src/lib/displayHistory.ts';
import {
  LIVE_MILLISECOND_INTERVAL_MS,
  normalizeClockInterval,
  SECOND_DISPLAY_INTERVAL_MS,
} from '../src/lib/useClockTick.ts';
import { createUuid } from '../src/lib/uuid.ts';
import { relativeFileWithinRoot } from '../server/static-files.ts';
import path from 'node:path';

test('browser UUIDs work when randomUUID is unavailable on a LAN HTTP origin', () => {
  const uuid = createUuid({
    getRandomValues(bytes) {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index;
      }
      return bytes;
    },
  });

  assert.equal(uuid, '00010203-0405-4607-8809-0a0b0c0d0e0f');
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

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

test('packaged static files stay relative to the AppImage mount root', () => {
  const hiddenMountRoot = path.join('/tmp', '.mount_LeuvenExample', 'resources', 'app.asar.unpacked');
  const distRoot = path.join(hiddenMountRoot, 'dist');

  assert.equal(
    relativeFileWithinRoot(distRoot, path.join(distRoot, 'assets', 'app.js.br')),
    path.join('assets', 'app.js.br')
  );
  assert.equal(relativeFileWithinRoot(distRoot, path.join(distRoot, 'index.html')), 'index.html');
  assert.equal(relativeFileWithinRoot(distRoot, path.join(hiddenMountRoot, 'secret.txt')), null);
});
