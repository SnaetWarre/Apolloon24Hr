import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { installHistoryProbe, instrumentBindings } from './history-client-page.mjs';
import { median, pairedMedianCI } from './history-client-stats.mjs';
import { installClockProbe } from './queue-clock-page.mjs';
import { processCpuTicks } from './queue-clock-stats.mjs';

const { values: args } = parseArgs({
  options: {
    fixtures: { type: 'string' },
    'base-binary': { type: 'string' },
    'base-web': { type: 'string' },
    'head-binary': { type: 'string', default: 'native/target/release/apolloon-native' },
    'head-web': { type: 'string', default: 'native/web-dist' },
    out: { type: 'string', default: `.tmp-bench/queue-clock-${Date.now()}` },
    pairs: { type: 'string', default: '10' },
    seconds: { type: 'string', default: '60' },
    warmup: { type: 'string', default: '5' },
    cases: {
      type: 'string',
      default: '500:queue,3000:queue,10000:queue,3000:display/inside,3000:display/competitions',
    },
    renderer: { type: 'string', default: 'webgl2' },
    'diagnostic-clock-step-ms': { type: 'string', default: '0' },
  },
});
for (const key of ['fixtures', 'base-binary', 'base-web']) assert(args[key], `--${key} is required`);
const root = path.resolve(import.meta.dirname, '../..'),
  out = path.resolve(args.out),
  pairs = Number(args.pairs),
  seconds = Number(args.seconds),
  warmup = Number(args.warmup),
  clockStepMs = Number(args['diagnostic-clock-step-ms']),
  expected = args.renderer === 'cpu' ? 'CPU' : 'WebGL2';
assert(['webgl2', 'cpu'].includes(args.renderer));
assert(Number.isInteger(pairs) && pairs >= 2);
assert(Number.isFinite(seconds) && seconds > 0 && Number.isFinite(warmup) && warmup >= 0);
assert(Number.isFinite(clockStepMs) && clockStepMs >= 0);
const cases = args.cases.split(',').map((entry) => {
  const [n, route] = entry.split(':');
  assert(Number.isInteger(Number(n)) && Number(n) > 0);
  assert(['queue', 'display/inside', 'display/competitions', 'display/outside'].includes(route));
  return { n: Number(n), route };
});
await mkdir(out, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = [];
assert.equal(process.platform, 'linux', 'server CPU counters require Linux /proc');
const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
assert(Number.isFinite(ticksPerSecond) && ticksPerSecond > 0);

function renderedClocks() {
  return [...document.querySelectorAll('[data-rune-a11y] *')]
    .filter((el) => !el.children.length && /^\d+:\d\d(?::\d\d)?$/.test(el.textContent))
    .map((el) => el.textContent);
}

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function run(version, n, route, pair) {
  const label = `${n}-${route.replaceAll('/', '-')}-${pair}-${version}`;
  const port = await freePort(),
    url = `http://127.0.0.1:${port}`,
    db = path.join(out, `${label}.db`);
  await copyFile(path.resolve(args.fixtures, `${n}.db`), db);
  const server = spawn(path.resolve(args[`${version}-binary`]), ['--server'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APOLLOON_NATIVE_DATA: db,
      APOLLOON_WEB_DIR: path.resolve(args[`${version}-web`]),
      CLUSTER_ENABLED: 'false',
      BACKUP_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '',
    browser;
  server.stdout.on('data', (data) => {
    log += data;
  });
  server.stderr.on('data', (data) => {
    log += data;
  });
  server.on('error', (error) => {
    log += error.message;
  });
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) {
      assert(server.exitCode === null && server.signalCode === null, log);
      try {
        ready = (await fetch(`${url}/api/health`)).ok;
      } catch {}
      if (ready) break;
      await sleep(30);
    }
    assert(ready, log);
    const p = await (await fetch(`${url}/api/state?history=1`)).json();
    assert.equal(p.stateHistory.laps.length, n);
    assert.equal(p.runners.length, 150);
    const now = Date.UTC(2026, 10, 21, 12);
    p.race.raceStartedAt = now - 3_630_000;
    p.race.raceFinishedAt = null;
    p.race.activeStartedAt = now - 30_000;
    p.race.activeRunnerId = p.runners[0].id;
    for (const [i, r] of p.runners.entries()) {
      r.status = i === 0 ? 'running' : i < 76 ? 'waiting' : 'warming_up';
      r.statusSince = now - 30_000 - i * 137;
      r.queueIndex = i;
    }
    p.latencyLap = 'initial';
    const initial = { p, now };
    browser = await chromium.launch({
      headless: true,
      args: [
        '--enable-unsafe-swiftshader',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route('**/app.js', async (request) => {
      const reply = await request.fetch();
      await request.fulfill({ response: reply, body: instrumentBindings(await reply.text()) });
    });
    await page.addInitScript({
      content: `(${installHistoryProbe.toString()})(${JSON.stringify({ initial, cpuOnly: expected === 'CPU' })});(${installClockProbe.toString()})(${JSON.stringify({ now, stepMs: clockStepMs })});`,
    });
    // Registration data belongs to the deterministic snapshot, not the live DB's older statuses.
    await page.route('**/api/action/runners.registrations', (request) => request.fulfill({ json: {} }));
    await page.goto(`${url}/${route}`);
    await page.waitForFunction(
      () =>
        window.apolloonLatencyLap === 'initial' &&
        window.__benchRenderer().kind !== 'pending' &&
        !document.querySelector('#status'),
      null,
      { timeout: 45000 }
    );
    const renderer = await page.evaluate(() => window.__benchRenderer());
    assert.equal(renderer.kind, expected, JSON.stringify(renderer));
    await sleep(warmup * 1000);
    const clocksBefore = await page.evaluate(renderedClocks);
    assert(clocksBefore.length > 0, 'rendered clock text must be present');
    const cdp = await browser.newBrowserCDPSession();
    const counterStart = performance.now();
    const serverBefore = processCpuTicks(await readFile(`/proc/${server.pid}/stat`, 'utf8'));
    const before = (await cdp.send('SystemInfo.getProcessInfo')).processInfo;
    await page.evaluate(() => window.__clockStart());
    await sleep(seconds * 1000);
    const sample = await page.evaluate(() => window.__clockStop());
    const after = (await cdp.send('SystemInfo.getProcessInfo')).processInfo;
    const serverAfter = processCpuTicks(await readFile(`/proc/${server.pid}/stat`, 'utf8'));
    const counterElapsedMs = performance.now() - counterStart;
    const clocksAfter = await page.evaluate(renderedClocks);
    assert.notDeepEqual(clocksAfter, clocksBefore, 'rendered clock text must advance');
    assert(
      sample.elapsedMs >= seconds * 1000 && sample.elapsedMs < seconds * 1000 + 2000,
      'measurement was suspended or stalled'
    );
    assert(Math.abs(counterElapsedMs - sample.elapsedMs) < 2000, 'counter windows must agree');
    assert.equal(sample.renderer.kind, expected);
    assert.deepEqual(sample.renderer.marks, renderer.marks, 'renderer changed during measurement');
    assert(sample.callbacks > 0 && sample.workMs > 0);
    assert(Math.abs(sample.clockElapsedMs - sample.elapsedMs) < Math.max(10, clockStepMs + 1), 'clocks must advance');
    const a = new Map(after.map((p) => [p.id, p]));
    assert(
      before.every((p) => a.has(p.id)),
      'a measured browser process exited'
    );
    const b = new Map(before.map((p) => [p.id, p]));
    const cpu = after.map((p) => ({ id: p.id, type: p.type, seconds: p.cpuTime - (b.get(p.id)?.cpuTime ?? 0) }));
    assert(cpu.every((p) => p.seconds >= 0));
    assert.deepEqual(errors, []);
    const elapsed = sample.elapsedMs / 1000;
    const row = {
      n,
      route,
      pair,
      version,
      renderer,
      sample,
      cpu,
      before,
      after,
      counterElapsedMs,
      clocksBefore,
      clocksAfter,
      serverBefore,
      serverAfter,
      appMsPerSec: sample.workMs / elapsed,
      framesPerSec: sample.frames / elapsed,
      requestedFramesPerSec: sample.requestedFrames / elapsed,
      drawFramesPerSec: sample.drawFrames / elapsed,
      scissorPixelsPerSec: sample.scissorPixels / elapsed,
      gpuCpuMsPerSec:
        (cpu.filter((p) => p.type === 'GPU').reduce((sum, p) => sum + p.seconds, 0) * 1e6) / counterElapsedMs,
      serverCpuMsPerSec: (((serverAfter - serverBefore) / ticksPerSecond) * 1e6) / counterElapsedMs,
      browserCpuMsPerSec: (cpu.reduce((sum, p) => sum + p.seconds, 0) * 1e6) / counterElapsedMs,
      rendererCpuMsPerSec:
        (cpu.filter((p) => p.type === 'renderer').reduce((sum, p) => sum + p.seconds, 0) * 1e6) / counterElapsedMs,
    };
    rows.push(row);
    await writeFile(path.join(out, 'results.json'), JSON.stringify(rows, null, 2));
    console.log(
      JSON.stringify({
        n,
        route,
        pair,
        version,
        appMsPerSec: row.appMsPerSec,
        browserCpuMsPerSec: row.browserCpuMsPerSec,
        rendererCpuMsPerSec: row.rendererCpuMsPerSec,
        serverCpuMsPerSec: row.serverCpuMsPerSec,
        frames: sample.frames,
        callbacks: sample.callbacks,
      })
    );
    if (pair === 0) await page.screenshot({ path: path.join(out, `${label}.png`) });
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await writeFile(path.join(out, `${label}.log`), log);
  }
}

for (const { n, route } of cases)
  for (let pair = 0; pair < pairs; pair++)
    for (const version of pair % 2 ? ['head', 'base'] : ['base', 'head']) await run(version, n, route, pair);

const summary = [];
for (const { n, route } of cases) {
  const selected = rows.filter((r) => r.n === n && r.route === route);
  assert.equal(selected.length, pairs * 2);
  for (const metric of [
    'framesPerSec',
    'requestedFramesPerSec',
    'drawFramesPerSec',
    'scissorPixelsPerSec',
    'appMsPerSec',
    'rendererCpuMsPerSec',
    'gpuCpuMsPerSec',
    'browserCpuMsPerSec',
    'serverCpuMsPerSec',
  ]) {
    const values = Object.fromEntries(
      ['base', 'head'].map((version) => [
        version,
        selected
          .filter((r) => r.version === version)
          .sort((a, b) => a.pair - b.pair)
          .map((r) => r[metric]),
      ])
    );
    const base = median(values.base),
      head = median(values.head);
    summary.push({
      n,
      route,
      metric,
      renderer: expected,
      pairs,
      seconds,
      base,
      head,
      percent: (head / base - 1) * 100,
      ci: pairedMedianCI(values.base, values.head),
      baseRange: [Math.min(...values.base), Math.max(...values.base)],
      headRange: [Math.min(...values.head), Math.max(...values.head)],
    });
  }
}
await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(
  path.join(out, 'method.json'),
  JSON.stringify(
    {
      args,
      renderer: expected,
      diagnostic: clockStepMs > 0,
      description: `${clockStepMs ? `DIAGNOSTIC ${clockStepMs}ms stepped clocks` : 'Real-time clocks'}. Sequential alternating base/head pairs; deterministic retained history and runner data; no pushes during measurement. In-page outermost WASM callback wall time; browser, GPU and renderer process CPU from CDP cumulative process counters; server CPU from Linux /proc ticks (idle backend, no state pushes). Frame callbacks and GL scissor bounding coverage are submission/work proxies, not completion or logical damage. Pointwise paired bootstrap difference of medians, 20000 resamples.`,
    },
    null,
    2
  )
);
console.log('SUMMARY', JSON.stringify(summary));
if (clockStepMs) console.log('DIAGNOSTIC ONLY: stepped clock; not a real-time performance result');
console.log(
  `${clockStepMs ? 'DIAGNOSTIC' : 'PASS'}: ${rows.length} runs, ${cases.length} cases, ${pairs} interleaved pairs, ${seconds}s racing/run; ${expected} throughout`
);
