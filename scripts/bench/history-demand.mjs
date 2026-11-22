import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { chromium } from 'playwright';
import { median, pairedMedianCI } from './history-client-stats.mjs';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    out: { type: 'string' },
    'base-assets': { type: 'string' },
    'head-assets': { type: 'string' },
    pairs: { type: 'string', default: '5' },
    pushes: { type: 'string', default: '5' },
  },
});
assert(args.base && args.head && args.out && args['base-assets'] && args['head-assets']);
const pairs = Number(args.pairs),
  pushes = Number(args.pushes),
  out = resolve(args.out);
assert(Number.isSafeInteger(pairs) && pairs >= 2 && Number.isSafeInteger(pushes) && pushes > 0);
await mkdir(out, { recursive: true });
const routes = [
  '/',
  '/queue',
  '/timing',
  '/admin',
  '/admin?section=laps',
  '/analysis',
  '/tactics',
  '/display/inside',
  '/display/competitions',
  '/display/outside',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, label, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(50);
  }
  throw Error('timeout: ' + label);
}
async function port() {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function json(url, input) {
  const r = await fetch(
    url,
    input === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }
  );
  assert(r.ok, `${url}: ${r.status} ${await r.clone().text()}`);
  return r.json();
}
function raw(url) {
  return new Promise((resolve, reject) =>
    http
      .get(url, { headers: { 'accept-encoding': 'br' } }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const bytes = Buffer.concat(chunks);
          const decoded =
            r.headers['content-encoding'] === 'br'
              ? brotliDecompressSync(bytes)
              : r.headers['content-encoding'] === 'gzip'
                ? gunzipSync(bytes)
                : bytes;
          resolve({
            encoded: bytes.length,
            decoded: decoded.length,
            encoding: r.headers['content-encoding'] ?? 'identity',
            value: JSON.parse(decoded),
          });
        });
      })
      .on('error', reject)
  );
}
const seed = `
import sqlite3,json,sys,time
c=sqlite3.connect(sys.argv[1]);c.executescript(open(sys.argv[2]).read());c.execute('PRAGMA user_version=17');c.execute('INSERT INTO race_state(id) VALUES(1)');n=int(sys.argv[3]);now=int(time.time()*1000);start=now-n*60001
for i in range(150):
 c.execute("INSERT INTO runners(id,runner_number,name,status,queue_index,status_since,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(f'bench-{i}',str(i+1),f'Bench {i:03}','running' if i==0 else 'waiting',i,now-120000,now,now))
labels=json.dumps([{'id':'team','name':'History team','color':'#123456','icon':'T','kind':'custom','imageUrl':None,'targetLaps':None,'sortOrder':None}],separators=(',',':'))
for i in range(n):
 c.execute("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,?,?,?,?,?,?)",(f'seed-{i}',f'bench-{i%150}',i//150+1,start+i*60001,start+(i+1)*60001,60001,'spacebar',now,labels))
c.execute("UPDATE race_state SET active_runner_id='bench-0',active_started_at=?,race_started_at=?,race_finished_at=NULL,active_labels_json='[]' WHERE id=1",(now-120000,start));c.commit()
`;
function renderer() {
  Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true });
  const get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
    if (['webgl', 'webgl2', 'experimental-webgl'].includes(kind)) return null;
    return get.call(this, kind, ...args);
  };
}
async function run(n, pair, version) {
  const directory = join(out, `${n}-${pair}-${version}`);
  await mkdir(directory, { recursive: true });
  const db = join(directory, 'app.db');
  execFileSync('python3', ['-c', seed, db, resolve('native/src/schema.sql'), String(n)]);
  const url = `http://127.0.0.1:${await port()}`;
  const child = spawn(resolve(args[version]), ['--server'], {
    env: {
      ...process.env,
      PORT: new URL(url).port,
      APOLLOON_NATIVE_DATA: db,
      CLUSTER_ENABLED: 'false',
      BACKUP_ENABLED: 'false',
      CLUSTER_DISCOVERY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '',
    browser;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (c) => (log += c));
  try {
    await eventually(async () => {
      try {
        return (await fetch(url + '/api/health')).ok;
      } catch {
        return false;
      }
    }, 'health');
    browser = await chromium.launch({
      args: [
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    const screens = await Promise.all(
      routes.map(async (route) => {
        const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
        await page.addInitScript(renderer);
        for (const file of ['app.js', 'app_bg.wasm'])
          await page.route('**/' + file, async (r) =>
            r.fulfill({
              body: await readFile(join(args[version + '-assets'], file)),
              contentType: file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
            })
          );
        const screen = { page, route, first: null, latest: null, pushDecoded: 0, pushWire: 0, active: false };
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Network.enable');
        const requests = new Set();
        cdp.on('Network.responseReceived', (e) => {
          if (e.response.url.includes('/api/state?')) requests.add(e.requestId);
        });
        cdp.on('Network.loadingFinished', (e) => {
          if (requests.delete(e.requestId)) {
            if (screen.active) screen.pushWire += e.encodedDataLength;
            else if (screen.firstWire === undefined) screen.firstWire = e.encodedDataLength;
          }
        });
        page.on('response', async (r) => {
          if (!r.url().includes('/api/state?')) return;
          try {
            const v = await r.json();
            if (v.unchanged) return;
            if (v.revision === undefined) return;
            const h = v.stateHistory;
            screen.latest = v;
            if (!screen.first)
              screen.first = { history: h, decodedHistory: h ? Buffer.byteLength(JSON.stringify(h)) : 0 };
            if (screen.active) screen.pushDecoded += h ? Buffer.byteLength(JSON.stringify(h)) : 0;
          } catch {}
        });
        await page.goto(url + route);
        await page.waitForFunction(
          () =>
            document.querySelector('[data-rune-a11y]') &&
            performance.getEntriesByName('web.gpu.failed').length &&
            !document.querySelector('#status'),
          null,
          { timeout: 90000 }
        );
        await eventually(() => screen.first !== null, 'first state ' + route);
        await sleep(200);
        await cdp.send('HeapProfiler.collectGarbage');
        screen.wasm = await page.evaluate(async () => {
          const m = await import('/app.js');
          return (await m.default()).memory.buffer.byteLength;
        });
        screen.heap = await cdp.send('Runtime.getHeapUsage');
        screen.rows = screen.first.history?.laps?.length ?? 0;
        const h = screen.first.history;
        screen.scope = h?.scope ?? 'none';
        screen.scopeEncoded = h
          ? await raw(url + '/api/history?scope=' + h.scope + (h.scope === 'recent' ? '&limit=' + h.limit : ''))
          : null;
        if (screen.scopeEncoded) delete screen.scopeEncoded.value;
        if (pair === 0)
          await page.screenshot({ path: join(directory, route.replaceAll(/[^a-zA-Z0-9]/g, '_') + '.png') });
        return screen;
      })
    );
    let race = (await json(url + '/api/state')).race;
    for (const s of screens) s.active = true;
    for (let i = 0; i < pushes; i++) {
      await json(url + '/api/action/race.handoff', {
        activeRunnerId: race.activeRunnerId,
        activeStartedAt: race.activeStartedAt,
        pressedAt: Math.max(Date.now(), race.activeStartedAt + 60001),
        measuredDurationMs: 60001,
        nextRunnerId: `bench-${i + 1}`,
      });
      const state = await json(url + '/api/state');
      race = state.race;
      await eventually(() => screens.every((s) => s.latest?.revision >= state.revision), 'all screens receive push');
    }
    for (const s of screens) s.active = false;
    return screens.map((s) => ({
      n,
      pair,
      version,
      route: s.route,
      renderer: 'CPU',
      rows: s.rows,
      scope: s.scope,
      decodedHistory: s.first.decodedHistory,
      scopeEncoded: s.scopeEncoded?.encoded ?? 0,
      firstStateWire: s.firstWire,
      wasm: s.wasm,
      jsHeap: s.heap.usedSize,
      pushDecoded: s.pushDecoded / pushes,
      pushStateWire: s.pushWire / pushes,
    }));
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await writeFile(join(directory, 'server.log'), log);
  }
}
const rows = [];
for (const n of [500, 3000, 10000])
  for (let pair = 0; pair < pairs; pair++)
    for (const version of pair % 2 ? ['head', 'base'] : ['base', 'head']) {
      rows.push(...(await run(n, pair, version)));
      await writeFile(join(out, 'results.json'), JSON.stringify(rows, null, 2));
      console.log(`DONE ${n} ${pair} ${version}`);
    }
const summary = [];
for (const n of [500, 3000, 10000])
  for (const route of routes)
    for (const metric of [
      'decodedHistory',
      'scopeEncoded',
      'firstStateWire',
      'wasm',
      'rows',
      'pushDecoded',
      'pushStateWire',
    ]) {
      const b = rows.filter((r) => r.n === n && r.route === route && r.version === 'base').map((r) => r[metric]);
      const h = rows.filter((r) => r.n === n && r.route === route && r.version === 'head').map((r) => r[metric]);
      summary.push({ n, route, metric, base: median(b), head: median(h), ci: pairedMedianCI(b, h) });
    }
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(
  `PASS: ${rows.length} screen observations; ${pairs} interleaved pairs at 500/3k/10k; CPU canvas throughout; ${pushes} acknowledged pushes/run`
);
