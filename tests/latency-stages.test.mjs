import assert from 'node:assert/strict';
import test from 'node:test';
import { stageMetrics, stageMarkdown, httpMetrics } from '../scripts/bench/latency.mjs';

test('latency stages join handoff tokens to lap ids and preserve microseconds', () => {
  const events = [
    { source: 'native', stage: 'key', id: 'runner@1', us: 100 },
    { source: 'native', stage: 'post_sent', id: 'runner@1', us: 125 },
    { source: 'A', stage: 'server_received', id: 'runner@1', us: 160 },
    { source: 'A', stage: 'replica_send', id: 'lap', lapId: 'lap', us: 170 },
    { source: 'B', stage: 'append_received', id: 'lap', lapId: 'lap', us: 180 },
    { source: 'B', stage: 'replica_apply', id: 'lap', lapId: 'lap', us: 190 },
    { source: 'A', stage: 'local_commit', id: 'runner@1', lapId: 'lap', us: 200 },
    { source: 'A', stage: 'ack_response', id: 'runner@1', lapId: 'lap', us: 250 },
    { source: 'native', stage: 'client_response', id: 'runner@1', lapId: 'lap', us: 270 },
  ];
  const { stages } = stageMetrics(events, [{ lapId: 'lap' }], [], 'A');
  assert.deepEqual(
    stages.filter((s) => s.n).map((s) => s.p50),
    [25, 35, 40, 50, 20, 90, 10, -10, 10, 10]
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

test('HTTP stages join the exact request, not another screen snapshot of the same lap', () => {
  const event = (source, stage, us, requestId = 'chosen') => ({ source, stage, us, requestId, lapId: 'lap' });
  const events = [
    event('A', 'notify', 0, null),
    event('A', 'waiter_wake', 2),
    event('A', 'snapshot_dispatch', 3),
    event('A', 'snapshot_worker', 4),
    event('A', 'history_lock_begin', 4),
    event('A', 'history_lock_ready', 5),
    event('A', 'writer_lock_begin', 5),
    event('A', 'writer_lock_ready', 6),
    event('A', 'read_cache_lookup_begin', 6),
    event('A', 'read_cache_lookup_ready', 6.5),
    event('A', 'read_connection_begin', 6),
    event('A', 'read_connection_ready', 8),
    event('A', 'read_cache_lock_begin', 8),
    event('A', 'read_cache_lock_ready', 9),
    event('A', 'snapshot_read_ready', 9),
    event('A', 'response_ready', 10),
    event('A', 'response_ready', 1, 'other'),
    event('native', 'http_headers', 12),
    event('native', 'http_body', 14),
    event('native', 'json_parsed', 17),
    event('native', 'json_parsed', 17.5, 'other'),
    event('native', 'push_received', 18),
    event('native', 'history_merged', 20),
    event('native', 'update_ready', 21),
    event('native', 'apply_begin', 25),
    event('native', 'applied', 27),
    { ...event('proxy A', 'wire_body', 13), headersUs: 11, encodedBodySize: 100 },
    { ...event('native', 'http_size', 17), decodedBodySize: 1000 },
  ];
  const screens = [{ name: 'native Timing', node: 'A' }];
  const [row] = httpMetrics(events, [{ lapId: 'lap' }], screens);
  assert.equal(row.notifyWakeUs, 2);
  assert.equal(row.workerQueueUs, 1);
  assert.equal(row.readSnapshotUs, 5);
  assert.equal(row.historyLockUs, 1);
  assert.equal(row.writerLockUs, 1);
  assert.equal(row.readConnectionUs, 2);
  assert.equal(row.readCacheLockUs, 1.5);
  assert.equal(row.responseToProxyUs, 1);
  assert.equal(row.proxyStreamUs, 2);
  assert.equal(row.proxyToClientBodyUs, 1);
  assert.equal(row.jsonParseUs, 3);
  assert.equal(row.clientHistoryUs, 2);
  assert.equal(row.updateQueueUs, 4);
  assert.equal(row.applyUs, 2);
  assert.equal(row.encodedBodySize, 100);
  assert.equal(row.decodedBodySize, 1000);
  assert.equal(row.serializeUs, undefined);
  const [unwaited] = httpMetrics(
    events.filter((e) => e.stage !== 'waiter_wake'),
    [{ lapId: 'lap' }],
    screens
  );
  assert.equal(unwaited.notifyWakeUs, undefined);
  assert.equal(unwaited.workerQueueUs, 1);
  const [cached] = httpMetrics(
    events.filter((e) => !e.stage.startsWith('read_connection_')),
    [{ lapId: 'lap' }],
    screens
  );
  assert.equal(cached.readConnectionUs, undefined);
  assert.deepEqual(httpMetrics([], [], screens), []);
  assert.deepEqual(
    httpMetrics(
      events.filter((e) => e.stage !== 'json_parsed'),
      [{ lapId: 'lap' }],
      screens
    ),
    [{ screen: 'native Timing', lapId: 'lap' }]
  );
});
