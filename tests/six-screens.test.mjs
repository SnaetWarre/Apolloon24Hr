import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFrameMetrics } from '../scripts/bench/latency.mjs';
import {
  browserLatencies,
  displayedHandoff,
  nativeLatencies,
  percentile,
  screenObservationsComplete,
  validateReplicaLaps,
} from '../scripts/bench/metrics.mjs';

test('native frame stages separate prior presentation, apply and redraw work', () => {
  const event = (stage, us, lapId) => ({ stage, us, lapId, source: 'native' });
  const events = [
    event('submit_begin', 0),
    event('push_received', 5, 'lap'),
    event('update_ready', 6, 'lap'),
    event('submit_end', 10),
    event('present_begin', 10),
    event('present_end', 20),
    event('build_begin', 21),
    event('acquire_begin', 21),
    event('acquire_end', 22),
    event('runtime_begin', 22),
    event('apply_begin', 22, 'lap'),
    event('applied', 25, 'lap'),
    event('runtime_end', 29),
    event('build_end', 30),
    event('submit_begin', 35),
    event('submit_end', 40),
    event('present_begin', 41),
    event('present_end', 50),
    event('frame', 51, 'lap'),
  ];
  assert.deepEqual(nativeFrameMetrics(events, [{ lapId: 'lap' }]), [
    {
      lapId: 'lap',
      urgentStateRequests: 0,
      urgentStateAdmission: 0,
      pushAppliedUs: 20,
      transportReadyUs: 1,
      previousSubmitUs: 4,
      previousPresentUs: 10,
      applyUs: 3,
      otherBeforeApplyUs: 2,
      buildUs: 6,
      acquireUs: 1,
      runtimeUs: 4,
      encodeUs: 5,
      submitUs: 5,
      presentUs: 9,
    },
  ]);
  assert.deepEqual(nativeFrameMetrics([], []), []);
  const withUrgent = [...events, event('redraw_begin', 20.5), event('urgent_state_admission', 20.75)];
  assert.equal(nativeFrameMetrics([...withUrgent, event('urgent_state_request', 6.5, 'lap'),
    { ...event('urgent_state_downgraded', 27, 'lap'), reason: 'duplicate_revision' },
    event('urgent_state_request', 53, 'other-lap')], [{ lapId: 'lap' }])[0].urgentStateRequests, 1);
  assert.equal(nativeFrameMetrics(withUrgent, [{ lapId: 'lap' }])[0].urgentStateAdmission, 1);
  assert.equal(
    nativeFrameMetrics([...withUrgent, event('redraw_begin', 20.9)], [{ lapId: 'lap' }])[0].urgentStateAdmission,
    0,
    'an override for an earlier redraw is not attributed to this lap frame'
  );
  const detail = [
    event('view_begin', 25),
    event('view_end', 25.5),
    event('layout_begin', 25.5),
    event('text_begin', 25.5),
    event('text_begin', 26),
    event('text_end', 26.25),
    event('text_end', 26.5),
    event('layout_end', 27),
    event('paint_begin', 27),
    event('glyph_begin', 27),
    event('atlas_begin', 27.25),
    event('atlas_end', 27.25),
    event('glyph_end', 28),
    event('paint_end', 29),
  ].map((e) => ({ ...e, cpuUs: e.us / 2 }));
  const [detailed] = nativeFrameMetrics([...events, ...detail], [{ lapId: 'lap' }]);
  assert.equal(detailed.viewUs, 0.5);
  assert.equal(detailed.layoutUs, 1.5);
  assert.equal(detailed.textUs, 1, 'nested shaping spans count their union, not their sum');
  assert.equal(detailed.textCpuUs, 0.5);
  assert.equal(detailed.paintUs, 2);
  assert.equal(detailed.glyphUs, 1);
  assert.equal(detailed.atlasUs, 0);
  assert.equal(detailed.fontFallbackUs, 0, 'no cold fallback in a traced frame is zero');
  assert.equal(detailed.runtimeCpuUs, undefined, 'legacy CPU clocks remain unavailable');
  const [broken] = nativeFrameMetrics(
    [...events, ...detail.filter((e) => e.stage !== 'layout_end'), event('font_fallback_end', 28)],
    [{ lapId: 'lap' }]
  );
  assert.equal(broken.layoutUs, undefined);
  assert.equal(broken.fontFallbackUs, undefined);
  const [noCpu] = nativeFrameMetrics([...events, ...detail.map((e) => ({ ...e, cpuUs: null }))], [{ lapId: 'lap' }]);
  assert.equal(noCpu.textUs, 1);
  assert.equal(noCpu.textCpuUs, undefined);
  const [legacy] = nativeFrameMetrics(
    events.filter((e) => !e.stage.startsWith('acquire_') && !e.stage.startsWith('runtime_')),
    [{ lapId: 'lap' }]
  );
  assert.equal(legacy.acquireUs, undefined);
  assert.equal(legacy.runtimeUs, undefined);
  assert.equal(legacy.fontFallbackUs, undefined);
  assert.equal(legacy.paintUs, undefined);
  const [partial] = nativeFrameMetrics(
    events.filter((e) => e.stage !== 'acquire_end'),
    [{ lapId: 'lap' }]
  );
  assert.equal(partial.acquireUs, undefined);
  assert.equal(partial.runtimeUs, 4);
  for (const incomplete of [
    events.filter((e) => e.stage !== 'acquire_begin'),
    [...events, event('acquire_begin', 21.5)],
  ]) {
    assert.equal(nativeFrameMetrics(incomplete, [{ lapId: 'lap' }])[0].acquireUs, undefined);
  }
  const [retries] = nativeFrameMetrics(
    [
      ...events.filter((e) => !e.stage.startsWith('acquire_')),
      event('acquire_begin', 21),
      event('acquire_end', 21),
      event('acquire_begin', 29),
      event('acquire_end', 30),
    ],
    [{ lapId: 'lap' }]
  );
  assert.equal(retries.acquireUs, 1, 'all attempts in the same frame are measured, including zero-time ones');
  assert.deepEqual(nativeFrameMetrics(events.slice(1), [{ lapId: 'missing' }]), [{ lapId: 'missing' }]);
  assert.deepEqual(
    nativeFrameMetrics(
      events.filter((e) => e.stage !== 'submit_end'),
      [{ lapId: 'lap' }]
    ),
    [{ lapId: 'lap' }]
  );
});

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

test('replica validation gate requires post-send observations on every browser and native pixels', () => {
  const write = { i: 0, sentAt: 100 };
  const screens = [
    { name: '/display/inside', text: 'Rondes|2241' },
    { name: '/display/competitions', text: 'Speedteam|2241' },
    { name: '/display/outside', text: 'Nu op de piste|Bench 01' },
    { name: '/queue', text: 'Klaar om te lopen|Bench 02' },
    { name: '/timing', text: 'Laatste rondes|1|Bench 00|ronde 57' },
  ].map(({ name, text }) => ({ name, frames: [{ at: 150, text }] }));
  const native = [{ at: 160, hash: 'lap' }];
  assert.equal(screenObservationsComplete(screens, native, write, 200), true);
  assert.equal(screenObservationsComplete([], native, write, 200), false);
  assert.equal(screenObservationsComplete(screens, [], write, 200), false);
  assert.equal(screenObservationsComplete(screens, [{ at: 90, hash: 'old' }], write, 200), false);
  assert.equal(screenObservationsComplete(screens, [...native, { at: 170, hash: 'ambiguous' }], write, 200), false);
  for (const missing of screens) {
    assert.equal(
      screenObservationsComplete(
        screens.map((s) => (s === missing ? { ...s, frames: [] } : s)),
        native,
        write,
        200
      ),
      false
    );
    assert.equal(
      screenObservationsComplete(
        screens.map((s) => (s === missing ? { ...s, frames: [{ ...s.frames[0], at: 90 }] } : s)),
        native,
        write,
        200
      ),
      false
    );
  }
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
