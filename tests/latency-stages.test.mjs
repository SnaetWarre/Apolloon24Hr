import assert from 'node:assert/strict';
import test from 'node:test';
import { stageMetrics, stageMarkdown } from '../scripts/bench/latency.mjs';

test('latency stages join handoff tokens to lap ids and preserve microseconds', () => {
  const events = [
    { source: 'native', stage: 'key', id: 'runner@1', us: 100 },
    { source: 'native', stage: 'post_sent', id: 'runner@1', us: 125 },
    { source: 'A', stage: 'server_received', id: 'runner@1', us: 160 },
    { source: 'A', stage: 'local_commit', id: 'runner@1', lapId: 'lap', us: 200 },
    { source: 'A', stage: 'ack_response', id: 'runner@1', lapId: 'lap', us: 250 },
    { source: 'native', stage: 'client_response', id: 'runner@1', lapId: 'lap', us: 270 },
  ];
  const { stages } = stageMetrics(events, [{ lapId: 'lap' }], [], 'A');
  assert.deepEqual(
    stages.filter((s) => s.n).map((s) => s.p50),
    [25, 35, 40, 50, 20]
  );
  assert(stages.every((s) => (s.n === 1 || s.n === 0) && s.p95 === s.max));
});

test('missing or empty trace stages are unavailable rather than zero or inferred frames', () => {
  for (const writes of [[], [{ lapId: 'missing', sentAt: 0 }]]) {
    const metrics = stageMetrics([], writes, [{ name: 'native Timing', node: 'A', values: [] }], 'A');
    assert(metrics.stages.every((s) => s.n === 0 && s.p95 === null));
    assert(stageMarkdown(metrics).includes('N/A'));
    assert.equal(metrics.nativeDrawnFrameIntervalsUs.n, 0);
  }
});
