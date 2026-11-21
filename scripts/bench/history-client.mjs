import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { installHistoryProbe, instrumentBindings } from './history-client-page.mjs';
import { summarizeHistory } from './history-client-stats.mjs';

const { values: args } = parseArgs({
  options: {
    fixtures: { type: 'string' },
    'base-binary': { type: 'string' },
    'base-web': { type: 'string' },
    'head-binary': { type: 'string', default: 'native/target/release/apolloon-native' },
    'head-web': { type: 'string', default: 'native/web-dist' },
    out: { type: 'string', default: `.tmp-bench/history-${Date.now()}` },
    pairs: { type: 'string', default: '12' },
    samples: { type: 'string', default: '5' },
    warmup: { type: 'string', default: '3' },
    laps: { type: 'string', default: '500,3000,10000' },
    routes: { type: 'string', default: 'analysis,tactics' },
    kinds: { type: 'string', default: 'notes-empty,no-history,one-lap' },
    renderer: { type: 'string', default: 'auto' },
    trace: { type: 'boolean', default: false },
  },
});
for (const name of ['fixtures', 'base-binary', 'base-web']) assert(args[name], `--${name} is required`);
const root = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(args.out);
const pairs = Number(args.pairs),
  samples = Number(args.samples),
  warmup = Number(args.warmup);
assert(Number.isInteger(pairs) && pairs >= 2, 'at least two pairs required (use >=10 for conclusions)');
assert(Number.isInteger(samples) && samples > 0 && Number.isInteger(warmup) && warmup >= 0);
assert(['auto', 'webgl2', 'cpu'].includes(args.renderer), 'renderer: auto, webgl2 or cpu');
const laps = args.laps.split(',').map(Number),
  routes = args.routes.split(','),
  kinds = args.kinds.split(',');
assert(laps.every((n) => Number.isInteger(n) && n > 0));
assert(routes.every((r) => ['analysis', 'tactics'].includes(r)));
assert(kinds.every((k) => ['notes-empty', 'no-history', 'one-lap'].includes(k)));
await mkdir(out, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class RendererMismatch extends Error {}

async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function fixture(original, n) {
  const p = structuredClone(original),
    start = Date.UTC(2026, 10, 21);
  assert.equal(p.stateHistory.laps.length, n, 'fixture lap count');
  assert(p.runners.length > 0, 'fixture has runners');
  p.race.raceStartedAt = start;
  p.race.raceFinishedAt = null;
  for (const [i, lap] of p.stateHistory.laps.entries()) {
    lap.durationMs = 55000 + (i % 51) * 700;
    lap.finishedAt = start + 60000 + (n - 1 - i) * 7000;
    lap.startedAt = lap.finishedAt - lap.durationMs;
  }
  p.race.activeStartedAt = p.stateHistory.laps[0].finishedAt;
  p.latencyLap = 'initial';
  return { p, now: p.stateHistory.laps[0].finishedAt + 30000 };
}

async function assertRenderer(page, expected) {
  const renderer = await page.evaluate(() => window.__benchRenderer());
  if (renderer.kind !== expected) throw new RendererMismatch(`expected ${expected}: ${JSON.stringify(renderer)}`);
  return renderer;
}

async function runVersion(version, n, run, expected, rows, dir) {
  const label = `${version}-${n}-${run}`,
    port = await freePort(),
    url = `http://127.0.0.1:${port}`;
  const db = path.join(dir, `${label}.db`);
  await copyFile(path.join(path.resolve(args.fixtures), `${n}.db`), db);
  const child = spawn(path.resolve(args[`${version}-binary`]), ['--server'], {
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
  child.stdout.on('data', (data) => {
    log += data;
  });
  child.stderr.on('data', (data) => {
    log += data;
  });
  child.on('error', (error) => {
    log += error.message;
  });
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) {
      assert(child.exitCode === null && child.signalCode === null, log);
      try {
        ready = (await fetch(`${url}/api/health`)).ok;
      } catch {}
      if (ready) break;
      await sleep(30);
    }
    assert(ready, `server not ready: ${log}`);
    const original = await (await fetch(`${url}/api/state?history=1`)).json();
    const initial = fixture(original, n);
    browser = await chromium.launch({
      headless: true,
      args: [
        '--enable-unsafe-swiftshader',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    for (const route of routes) {
      const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark' });
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.route('**/app.js', async (request) => {
        const reply = await request.fetch();
        await request.fulfill({ response: reply, body: instrumentBindings(await reply.text()) });
      });
      await page.addInitScript(installHistoryProbe, { initial, cpuOnly: expected === 'CPU' });
      await page.goto(`${url}/${route}`);
      await page.waitForFunction(
        () => window.apolloonLatencyLap === 'initial' && window.__deliver && !document.querySelector('#status'),
        null,
        { timeout: 45000 }
      );
      await page.waitForFunction(() => window.__benchRenderer().kind !== 'pending', null, { timeout: 45000 });
      const renderer = await assertRenderer(page, expected);
      await page.waitForTimeout(500);
      let cdp, trace;
      if (args.trace) {
        cdp = await page.context().newCDPSession(page);
        trace = [];
        cdp.on('Tracing.dataCollected', (event) => trace.push(...event.value));
        await cdp.send('Tracing.start', {
          categories: 'toplevel,devtools.timeline,v8,v8.wasm,blink.user_timing',
          transferMode: 'ReportEvents',
        });
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
        await cdp.send('Profiler.start');
      }
      const state = structuredClone(initial.p),
        held = state.stateHistory;
      let seq = 0,
        now = initial.now;
      for (const kind of kinds) {
        const measured = [];
        for (let i = -warmup; i < samples; i++) {
          await page.waitForFunction(() => !!window.__deliver);
          const p = structuredClone(state);
          seq++;
          p.latencyLap = `bench-${seq}`;
          p.changeToken = `bench-token-${seq}`;
          if (kind === 'no-history') {
            delete p.stateHistory;
            p.host = { ...p.host, bench: seq };
          } else {
            p.revision++;
            p.runners.at(-1).notes = `bench-notes-${seq}`;
            const cursor = `bench-cursor-${seq}`;
            const change = { count: held.laps.length, changed: [], removed: [] };
            if (kind === 'one-lap') {
              now += 15000;
              const lap = {
                ...held.laps[0],
                id: `new-${seq}`,
                durationMs: 65000,
                finishedAt: now - 1000,
                startedAt: now - 66000,
              };
              held.laps.unshift(lap);
              change.count++;
              change.changed.push([0, lap]);
              p.race.activeStartedAt = lap.finishedAt;
            }
            p.stateHistory = {
              delta: true,
              since: held.cursor,
              cursor,
              revision: p.revision,
              changes: { laps: change, events: { count: held.events.length, changed: [], removed: [] } },
            };
            held.cursor = cursor;
            held.revision = p.revision;
          }
          Object.assign(state, p);
          await page.evaluate((next) => window.__benchPrepare(next), { p, now });
          const sample = await page.evaluate(() => window.__benchMeasure());
          assert.equal(sample.renderer.kind, expected, 'renderer must remain unchanged during every push');
          assert(
            sample.callbacks > 0 && sample.workMs > 0 && sample.elapsedMs >= sample.workMs,
            'instrumented app work through applied frame'
          );
          if (i >= 0) measured.push(sample);
          await page.waitForTimeout(75);
        }
        const row = { n, run, version, route, kind, renderer, samples: measured };
        rows.push(row);
        console.log(JSON.stringify(row));
        await writeFile(path.join(dir, 'results.json'), JSON.stringify(rows, null, 2));
      }
      await assertRenderer(page, expected);
      assert.deepEqual(errors, []);
      if (cdp) {
        const profile = await cdp.send('Profiler.stop');
        await writeFile(path.join(dir, `${label}-${route}.cpuprofile`), JSON.stringify(profile.profile));
        const ended = once(cdp, 'Tracing.tracingComplete');
        await cdp.send('Tracing.end');
        await ended;
        await writeFile(path.join(dir, `${label}-${route}.trace.json`), JSON.stringify({ traceEvents: trace }));
      }
      await page.close();
    }
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit');
      child.kill();
      await done;
    }
    await writeFile(path.join(dir, `${label}.log`), log);
  }
}

let completed = false;
for (const renderer of args.renderer === 'auto' ? ['WebGL2', 'CPU'] : [args.renderer === 'cpu' ? 'CPU' : 'WebGL2']) {
  const dir = path.join(out, renderer);
  await mkdir(dir, { recursive: true });
  const rows = [];
  try {
    for (const n of laps)
      for (let run = 0; run < pairs; run++) {
        for (const version of run % 2 ? ['head', 'base'] : ['base', 'head'])
          await runVersion(version, n, run, renderer, rows, dir);
      }
  } catch (error) {
    await writeFile(path.join(dir, 'failure.txt'), String(error.stack));
    if (!(error instanceof RendererMismatch) || args.renderer !== 'auto' || renderer !== 'WebGL2') throw error;
    console.log(
      `Renderer fallback: discard incomplete WebGL2 attempt and repeat BOTH versions on CPU: ${error.message}`
    );
    continue;
  }
  const summary = summarizeHistory(rows);
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(
    path.join(out, 'method.json'),
    JSON.stringify(
      {
        args,
        renderer,
        metric: 'exclusive in-page WASM callback wall ms through the applied Rune frame',
        statistic:
          'median of per-run sample medians; paired percentile bootstrap difference of medians, 20000 resamples, pointwise 95% CI',
      },
      null,
      2
    )
  );
  console.log('SUMMARY', JSON.stringify(summary));
  console.log(
    `PASS: ${rows.length} run/case rows, ${summary.length} comparisons, ${pairs} interleaved pairs; renderer ${renderer} throughout`
  );
  completed = true;
  break;
}
assert(completed, 'no renderer completed both versions');
