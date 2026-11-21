import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import {
  options,
  schedule,
  distribution,
  errorClass,
  writeErrorSummary,
  recoveryTiming,
  compactSummary,
  isRunSummary,
  latestRun,
  historyPath,
  endpointKey,
  responseBody,
} from '../scripts/stress/race.mjs';

test('screen history paths retain node cursors without creating unbounded metric buckets', () => {
  assert.equal(historyPath(), '/api/history?scope=full');
  assert.equal(historyPath('epoch.1'), '/api/history?scope=full&since=epoch.1');
  assert.equal(historyPath('a&b'), '/api/history?scope=full&since=a%26b');
  assert.equal(endpointKey(historyPath('epoch.1')), endpointKey(historyPath('epoch.2')));
  assert.notEqual(endpointKey(historyPath('epoch.1')), endpointKey(historyPath()));
  assert.equal(endpointKey('/api/history?scope=recent'), '/api/history?scope=recent');
});

test('HTTP payload metrics distinguish encoded bytes from decoded JSON, including error and empty bodies', async () => {
  const payload = JSON.stringify({ laps: Array(100).fill({ id: 'lap' }) });
  const server = createServer((req, res) => {
    assert.equal(req.headers['accept-encoding'], 'gzip, br');
    const encoding = req.url.slice(1);
    if (encoding === 'empty') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (encoding === 'error') {
      res.writeHead(503);
      res.end('No writable leader');
      return;
    }
    if (encoding === 'broken') {
      res.writeHead(200, { 'Content-Encoding': 'gzip' });
      res.end('invalid gzip');
      return;
    }
    res.writeHead(200, encoding === 'identity' ? {} : { 'Content-Encoding': encoding });
    res.end(encoding === 'gzip' ? gzipSync(payload) : encoding === 'br' ? brotliCompressSync(payload) : payload);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const encoding of ['gzip', 'br', 'identity']) {
      const response = await responseBody(`${url}/${encoding}`);
      assert.equal(response.raw, payload);
      assert.equal(response.bytes, Buffer.byteLength(payload));
      assert.equal(response.encoding, encoding);
      assert(
        encoding === 'identity' ? response.encodedBytes === response.bytes : response.encodedBytes < response.bytes
      );
    }
    assert.equal((await responseBody(`${url}/empty`)).bytes, 0);
    assert.equal((await responseBody(`${url}/error`, { action: 'probe' })).status, 503);
    await assert.rejects(responseBody(`${url}/broken`));
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('stress flags have safe defaults and reject malformed inputs', () => {
  assert.equal(options([]).ratio, 60);
  assert.equal(options([]).chaos, 'on');
  assert.equal(options([]).work, '.tmp-stress');
  assert.equal(options(['--out', '/tmp/summary', '--work', '/tmp/work']).work, '/tmp/work');
  assert.equal(options(['--out', '/tmp/work/summaries', '--work', '/tmp/work']).work, '/tmp/work');
  assert.equal(options(['--hours', '2', '--seed', 'night']).hours, 2);
  assert.equal(options(['--laps', '1115', '--chaos', 'off']).laps, 1115);
  assert.equal(options(['--chaos', 'off']).chaos, 'off');
  for (const args of [
    ['--hours', '0'],
    ['--ratio', 'NaN'],
    ['--laps', '0'],
    ['--laps', '1.5'],
    ['--chaos', 'false'],
    ['--other', '1'],
    ['--out'],
    ['--out', '/tmp/out', '--work', '/tmp/out'],
    ['--out', '/tmp/out', '--work', '/tmp/out/work'],
  ])
    assert.throws(() => options(args));
});
test('transport failures on injected-down screens remain distinct from live responses and leader failures', () => {
  assert.equal(errorClass({}, true), 'injectedUnavailable');
  assert.equal(errorClass({ status: 503 }, true), 'liveResponse');
  assert.equal(errorClass({}, false), 'liveTransport');
  const summary = writeErrorSummary([
    { write: true, error: 'fetch failed', chaos: 'laptop-out', errorClass: 'injectedUnavailable' },
    { write: true, error: 'HTTP 503: No writable leader', chaos: 'two-down', errorClass: 'liveResponse' },
    { write: true, error: 'No writable leader', errorClass: 'noWritableLeader' },
    { write: true, error: 'fetch failed', errorClass: 'liveTransport' },
    { write: false, error: 'fetch failed', errorClass: 'injectedUnavailable' },
    { write: true },
  ]);
  assert.deepEqual([summary.insideChaos, summary.outsideChaos, summary.total], [2, 2, 4]);
  assert.deepEqual(summary.byCause.injectedUnavailable, { insideChaos: 1, outsideChaos: 0, total: 1 });
  assert.equal(summary.byCause.liveResponse.total, 1);
  assert.equal(summary.byCause.noWritableLeader.outsideChaos, 1);
  assert.equal(summary.byCause.liveTransport.outsideChaos, 1);
  assert.equal(writeErrorSummary([]).total, 0);
});
test('recovery timings exclude the planned outage, retaining total disruption separately', () => {
  assert.deepEqual(recoveryTiming(0, 10, 90010, 90110, 90130), {
    timingOrigin: 'restore',
    outageMs: 90000,
    caughtUpMs: 100,
    recoveryMs: 120,
    disruptionMs: 90130,
  });
});
const rawRun = () => ({
  passed: true,
  config: {},
  metrics: {},
  growth: [],
  failures: [],
  requests: [{ error: 'raw request' }],
  acknowledgements: [{ lapId: 'raw-id' }],
  schedule: { laps: [60], chaos: [] },
  histories: [{ laps: [{ id: 'raw-id' }] }],
  final: { statuses: [], lapIds: [['raw-id']] },
  resources: [],
  events: [{ kind: 'laptop-out' }, { kind: 'write-attempt-error' }],
});
test('summary removes raw series and bounds samples, retaining per-node endpoints', () => {
  const run = rawRun();
  run.resources = ['A', 'B', 'C'].flatMap((node) =>
    Array.from({ length: 10000 }, (_, wallMs) => ({ node, wallMs, rssBytes: 1000 }))
  );
  const summary = compactSummary(run);
  for (const key of ['requests', 'acknowledgements', 'schedule', 'histories']) assert.equal(key in summary, false);
  assert.deepEqual(summary.final, { statuses: [], lapCounts: [1] });
  assert.equal(summary.resources.length, 360);
  assert.deepEqual(
    summary.resources
      .filter((r) => r.node === 'A')
      .map((r) => r.wallMs)
      .filter((n) => n === 0 || n === 9999),
    [0, 9999]
  );
  assert.deepEqual(summary.events, [{ kind: 'laptop-out' }]);
  assert.equal(summary.counts.failedAttempts, 1);
  assert(Buffer.byteLength(JSON.stringify(summary)) < 500000);
  assert.equal(compactSummary(rawRun()).resources.length, 0);
  assert.equal(isRunSummary(summary), true);
  assert.equal(Boolean(isRunSummary(null)), false);
  assert.equal(Boolean(isRunSummary({ passed: true })), false);
});
test('automatic comparison ignores unrelated and malformed JSON and supports legacy runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stress-summary-test-'));
  try {
    assert.equal(await latestRun(dir), undefined);
    await writeFile(join(dir, 'legacy.json'), JSON.stringify(rawRun()));
    await utimes(join(dir, 'legacy.json'), 1, 1);
    await writeFile(join(dir, 'summary.json'), JSON.stringify(compactSummary(rawRun())));
    await writeFile(join(dir, 'unrelated.json'), '{"other":true}');
    await writeFile(join(dir, 'broken.json'), 'not JSON');
    assert.equal(await latestRun(dir), join(dir, 'summary.json'));
    await rm(join(dir, 'summary.json'));
    assert.equal(await latestRun(dir), join(dir, 'legacy.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('race schedule is reproducible, ordered and seed-dependent', () => {
  const a = schedule(24, 'night');
  assert.deepEqual(a, schedule(24, 'night'));
  assert.notDeepEqual(a, schedule(24, 'different'));
  assert.equal(a.chaos.length, 5);
  assert(a.laps.every((s, i) => s > 0 && (i === 0 || s > a.laps[i - 1])));
  assert.deepEqual(schedule(0, 'empty').laps, []);
});
test('a fixed lap count spans the race and preserves tightly spaced handoffs', () => {
  const { laps } = schedule(24, 'night', 1115);
  assert.equal(laps.length, 1115);
  assert(laps[0] > 0 && laps[0] < 120);
  assert(laps.at(-1) > 24 * 3600 - 120 && laps.at(-1) < 24 * 3600);
  assert(laps.every((s, i) => i === 0 || s > laps[i - 1]));
  assert(laps.some((s, i) => s - laps[i - 1] < 5));
  assert.equal(schedule(24, 'night', 80).laps.length, 80);
});
test('percentiles cover populated and empty series without mutating input', () => {
  const values = [4, 1, 3, 2];
  assert.deepEqual(distribution(values), { count: 4, p50: 2, p95: 4, p99: 4, max: 4 });
  assert.equal(values[0], 4);
  assert.deepEqual(distribution([]), { count: 0, p50: null, p95: null, p99: null, max: null });
});
