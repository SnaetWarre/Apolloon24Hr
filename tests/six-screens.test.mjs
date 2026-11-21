import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserLatencies,
  displayedHandoff,
  nativeLatencies,
  percentile,
  validateReplicaLaps,
} from '../scripts/bench/metrics.mjs';

test('screen observations follow rendered totals, active runner and waiting lane', () => {
  assert.equal(displayedHandoff('/timing', { text: 'Hierna|Bench 01|Laatste rondes|1|Bench 00|ronde 57|12:34' }), 0);
  assert.equal(displayedHandoff('/timing', { text: 'Laatste rondes|40|Bench 39|ronde 56|12:34' }), -1);
  assert.equal(displayedHandoff('/timing', { text: 'Laatste rondes|2|Bench 01|ronde 57|12:34' }), 1);
  assert.equal(displayedHandoff('/timing', { text: 'Laatste rondes|Bench 00' }), null);
  assert.equal(displayedHandoff('/display/inside', { text: 'Rondes|2.242' }), 1);
  assert.equal(displayedHandoff('/display/competitions', { text: 'Speedteam|2 243' }), 2);
  assert.equal(displayedHandoff('/display/outside', { text: 'Nu op de piste|Bench 01|Volgende|Bench 02' }), 0);
  assert.equal(
    displayedHandoff('/queue', { text: 'Klaar om te lopen|Bench 02: profiel openen|Bench 03: profiel openen' }),
    0
  );
});
test('empty and unrelated trees never count as observations', () => {
  assert.equal(displayedHandoff('/timing', { text: '12:34|2239' }), null);
  assert.equal(displayedHandoff('/queue', { text: 'Klaar om te lopen|0 lopers' }), null);
  assert.equal(displayedHandoff('/display/outside', { text: 'Apolloon laden' }), null);
  assert.deepEqual(browserLatencies('/timing', [], [{ i: 0, sentAt: 100 }]), [null]);
  assert.equal(percentile([], 0.95), null);
});
test('later rendered state covers coalesced writes, never pre-send state', () => {
  const writes = [
    { i: 0, sentAt: 100 },
    { i: 1, sentAt: 200 },
  ];
  const frames = [
    { at: 50, text: 'Laatste rondes|2|Bench 01|ronde 57' },
    { at: 150, text: 'Laatste rondes|40|Bench 39|ronde 56' },
    { at: 250, text: 'Laatste rondes|2|Bench 01|ronde 57' },
  ];
  assert.deepEqual(browserLatencies('/timing', frames, writes), [150, 50]);
  assert.equal(percentile([300, 100, 200], 0.95), 300);
});
test('native ambiguous or missing pixel changes are invalid, not silently attributed', () => {
  const writes = [{ sentAt: 100 }, { sentAt: 200 }];
  assert.deepEqual(
    nativeLatencies(
      [
        { at: 125, hash: 'a' },
        { at: 220, hash: 'b' },
      ],
      writes,
      300
    ),
    [25, 20]
  );
  assert.deepEqual(
    nativeLatencies(
      [
        { at: 125, hash: 'a' },
        { at: 130, hash: 'b' },
      ],
      writes,
      300
    ),
    [null, null]
  );
});

test('replicas preserve seed IDs and agree on exactly one new unique lap per press', () => {
  const history = (...ids) => ({ laps: ids.map((id) => ({ id })) });
  assert.deepEqual(validateReplicaLaps([history('seed'), history('seed')], ['seed'], 0), []);
  assert.deepEqual(validateReplicaLaps([history('seed', 'lap'), history('lap', 'seed')], ['seed'], 1), ['lap']);
  assert.equal(validateReplicaLaps([], [], 0), null);
  assert.equal(validateReplicaLaps([history('seed', 'lap', 'lap')], ['seed'], 2), null);
  assert.equal(validateReplicaLaps([history('seed'), history('seed', 'lap')], ['seed'], 1), null);
  assert.equal(validateReplicaLaps([history('seed', 'lap'), history('seed', 'other')], ['seed'], 1), null);
  assert.equal(validateReplicaLaps([history('replacement', 'lap')], ['seed'], 1), null);
  assert.equal(validateReplicaLaps([history('seed', 'lap', 'extra')], ['seed'], 1), null);
});
