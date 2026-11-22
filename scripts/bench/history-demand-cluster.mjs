import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, createConnection } from 'node:net';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { processCpuTicks } from './queue-clock-stats.mjs';
import { median, pairedMedianCI } from './history-client-stats.mjs';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    'base-assets': { type: 'string' },
    'head-assets': { type: 'string' },
    out: { type: 'string' },
    pairs: { type: 'string', default: '10' },
    laps: { type: 'string', default: '40' },
    spacing: { type: 'string', default: '1000' },
    renderer: { type: 'string', default: 'cpu' },
    sizes: { type: 'string', default: '500,3000,10000' },
  },
});
assert(args.base && args.head && args.out, '--base/--head server binaries and --out required');
assert(['cpu', 'webgl2'].includes(args.renderer), '--renderer cpu or webgl2');
const expectedRenderer = args.renderer === 'cpu' ? 'CPU' : 'WebGL2';
const pairs = Number(args.pairs),
  laps = Number(args.laps),
  spacing = Number(args.spacing);
assert(
  Number.isInteger(pairs) && pairs >= 1 && Number.isInteger(laps) && laps >= 2 && spacing >= 100,
  'invalid counts'
);
const out = resolve(args.out);
const sizes = args.sizes.split(',').map(Number);
assert(sizes.every((n) => Number.isSafeInteger(n) && n > 0));
await mkdir(out, { recursive: true });
const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));
const ticksPerSecond = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
async function eventually(fn, label, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    await sleep(100);
  }
  throw new Error('timeout: ' + label);
}
async function port() {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = s.address().port;
  await new Promise((done) => s.close(done));
  return p;
}
async function proxy(node) {
  node.egress = 0;
  node.peerRequests = 0;
  node.sockets = new Set();
  node.proxy = createServer((socket) => {
    const backend = createConnection({ host: '127.0.0.1', port: node.backendPort });
    node.sockets.add(socket);
    node.sockets.add(backend);
    let header = Buffer.alloc(0),
      signed = null,
      pending = 0;
    socket.on('data', (chunk) => {
      if (signed === null) {
        pending += chunk.length;
        header = Buffer.concat([header, chunk]);
        if (header.includes('\r\n\r\n')) {
          signed = header.toString('latin1').toLowerCase().includes('\r\nx-apolloon-group:');
          if (signed) {
            node.egress += pending;
            node.peerRequests++;
          }
          header = null;
        }
      } else if (signed) node.egress += chunk.length;
    });
    backend.on('data', (chunk) => {
      node.egress += chunk.length;
    });
    for (const s of [socket, backend]) {
      s.on('error', () => {
        socket.destroy();
        backend.destroy();
      });
      s.on('close', () => node.sockets.delete(s));
    }
    socket.pipe(backend);
    backend.pipe(socket);
  }).listen(node.port, '127.0.0.1');
  await once(node.proxy, 'listening');
}
async function json(url, input) {
  const response = await fetch(
    url,
    input === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }
  );
  assert(response.ok, `${url}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
const action = (node, method, input) => json(node.url + '/api/action/' + method, input);
const status = (node) => json(node.url + '/api/cluster/status');
const cpu = async (nodes) =>
  Promise.all(
    nodes.map(
      async (node) => (processCpuTicks(await readFile(`/proc/${node.child.pid}/stat`, 'utf8')) * 1000) / ticksPerSecond
    )
  );
function encodedScope(url) {
  return new Promise((resolve, reject) =>
    http
      .get(url, { headers: { 'accept-encoding': 'br' } }, (r) => {
        let bytes = 0;
        r.on('data', (c) => (bytes += c.length));
        r.on('end', () => resolve({ bytes, encoding: r.headers['content-encoding'] ?? 'identity' }));
      })
      .on('error', reject)
  );
}
const seed = `
import sqlite3,json,sys,time
c=sqlite3.connect(sys.argv[1]); c.executescript(open(sys.argv[2]).read()); c.execute('PRAGMA user_version=17'); c.execute('INSERT INTO race_state(id) VALUES(1)'); now=int(time.time()*1000); n=int(sys.argv[3]); start=now-n*60001
for i in range(150):
 c.execute("INSERT INTO runners(id,runner_number,name,status,queue_index,status_since,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(f'bench-{i}',str(i+1),f'Bench {i:03}', 'running' if i==0 else 'waiting',i,now-120000,now,now))
labels=json.dumps([{'id':'team','name':'History team','color':'#123456','icon':'T','kind':'custom','imageUrl':None,'targetLaps':None,'sortOrder':None}],separators=(',',':'))
for i in range(n):
 c.execute("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,?,?,?,?,?,?)",(f'seed-{i}',f'bench-{i%150}',i//150+1,start+i*60001,start+(i+1)*60001,60001,'spacebar',now,labels))
c.execute("UPDATE race_state SET active_runner_id='bench-0',active_started_at=?,race_started_at=?,race_finished_at=NULL,active_labels_json='[]' WHERE id=1",(now-120000,start)); assert c.execute('SELECT active_runner_id FROM race_state').fetchone()[0]=='bench-0'; c.commit()
`;
function rendererProbe(cpuOnly) {
  Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true });
  const kinds = new Set(),
    get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...options) {
    if (cpuOnly && ['webgl2', 'webgl', 'experimental-webgl'].includes(kind)) return null;
    const value = get.call(this, kind, ...options);
    if (value) kinds.add(kind);
    return value;
  };
  window.__runnerRenderer = () => {
    const done = performance.getEntriesByName('web.handover.done').at(-1)?.startTime ?? -1;
    const failed = Math.max(
      ...['web.gpu.failed', 'web.handover.failed', 'web.gpu.lost'].map(
        (name) => performance.getEntriesByName(name).at(-1)?.startTime ?? -1
      )
    );
    return {
      kind: done > failed && kinds.has('webgl2') ? 'WebGL2' : failed >= 0 && failed > done ? 'CPU' : 'pending',
      kinds: [...kinds],
      done,
      failed,
    };
  };
}
async function run(pair, version, n) {
  const directory = join(out, `${n}-${pair}-${version}`);
  await mkdir(directory, { recursive: true });
  const nodes = await Promise.all(
    ['A', 'B', 'C'].map(async (name) => {
      const p = await port(),
        backendPort = await port();
      return { name, backendPort, port: p, url: `http://127.0.0.1:${p}`, db: join(directory, name + '.db'), log: '' };
    })
  );
  execFileSync('python3', ['-c', seed, nodes[0].db, resolve('native/src/schema.sql'), String(n)]);
  let browser;
  try {
    for (const node of nodes) {
      await proxy(node);
      node.child = spawn(resolve(args[version]), ['--server'], {
        env: {
          ...process.env,
          PORT: String(node.backendPort),
          APOLLOON_NATIVE_DATA: node.db,
          CLUSTER_ENABLED: 'true',
          CLUSTER_DISCOVERY: 'false',
          CLUSTER_AUTO_LINK: 'false',
          CLUSTER_SELF_URL: node.url,
          CLUSTER_LAPTOP_NAME: node.name,
          BACKUP_ENABLED: 'false',
          APOLLOON_LATENCY_TRACE: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      node.child.stdout.on('data', (chunk) => {
        node.log += chunk;
      });
      node.child.stderr.on('data', (chunk) => {
        node.log += chunk;
      });
      await eventually(async () => (await fetch(node.url + '/api/health')).ok, 'health ' + node.name);
    }
    for (const node of nodes.slice(1)) {
      await action(node, 'cluster.joinGroup', { url: nodes[0].url });
      await eventually(
        async () =>
          (await status(nodes[0])).members.length === nodes.indexOf(node) + 1 && !(await status(nodes[0])).busy,
        'join'
      );
    }
    await eventually(
      async () => (await Promise.all(nodes.map(status))).every((s) => s.writable && !s.busy && s.members.length === 3),
      'convergence'
    );
    const states = await Promise.all(nodes.map(status));
    const leader = nodes[states.findIndex((s) => s.role === 'leader')];
    assert(leader);
    await action(leader, 'cluster.openTiming', { takeOver: true });
    browser = await chromium.launch({
      args: [
        '--enable-unsafe-swiftshader',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    const screens = [];
    for (const [i, route] of [
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
    ].entries()) {
      const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
      await page.addInitScript(rendererProbe, args.renderer === 'cpu');
      let replies = 0;
      const sample = { initial: null, active: false, pushDecoded: 0, pushStateWire: 0 };
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      const stateRequests = new Set();
      cdp.on('Network.responseReceived', (e) => {
        if (e.response.url.includes('/api/state?')) stateRequests.add(e.requestId);
      });
      cdp.on('Network.loadingFinished', (e) => {
        if (stateRequests.delete(e.requestId)) {
          if (sample.active) sample.pushStateWire += e.encodedDataLength;
          else if (sample.firstStateWire === undefined) sample.firstStateWire = e.encodedDataLength;
        }
      });
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/api/state' && response.ok()) replies++;
      });
      page.on('response', async (response) => {
        if (!response.url().includes('/api/state?')) return;
        try {
          const v = await response.json();
          if (v.unchanged || v.revision === undefined) return;
          if (!sample.initial)
            sample.initial = {
              scope: v.stateHistory?.scope ?? 'none',
              rows: v.stateHistory?.laps.length ?? 0,
              decodedHistory: v.stateHistory ? Buffer.byteLength(JSON.stringify(v.stateHistory)) : 0,
            };
          if (sample.active)
            sample.pushDecoded += v.stateHistory ? Buffer.byteLength(JSON.stringify(v.stateHistory)) : 0;
        } catch {}
      });
      const node = nodes[i % nodes.length];
      const assets = args[version + '-assets'];
      if (assets)
        for (const file of ['app.js', 'app_bg.wasm'])
          await page.route('**/' + file, async (route) => {
            await route.fulfill({
              body: await readFile(join(assets, file)),
              contentType: file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
            });
          });
      await page.goto(node.url + route);
      await page.waitForFunction(
        (renderer) => window.__runnerRenderer().kind === renderer && document.querySelector('[data-rune-a11y]'),
        expectedRenderer,
        { timeout: 60000 }
      );
      await eventually(() => sample.initial, 'first snapshot');
      sample.wasm = await page.evaluate(async () => {
        const m = await import('/app.js');
        return (await m.default()).memory.buffer.byteLength;
      });
      const scoped = sample.initial.scope;
      sample.scopeEncoded =
        scoped === 'none'
          ? 0
          : (
              await encodedScope(
                node.url +
                  '/api/history?scope=' +
                  scoped +
                  (scoped === 'recent' ? '&limit=' + (route === '/' ? 7 : 5) : '')
              )
            ).bytes;
      screens.push({ page, route, node: node.name, replies: () => replies, sample });
    }
    const initial = await json(leader.url + '/api/state');
    let race = initial.race;
    await sleep(3000);
    const idleBefore = await cpu(nodes),
      idleAt = performance.now();
    await sleep(5000);
    const idleAfter = await cpu(nodes),
      idleMs = performance.now() - idleAt;
    const bytesBefore = nodes.reduce((a, n) => a + n.egress, 0);
    const before = await cpu(nodes),
      start = performance.now();
    const initialReplies = screens.map((s) => s.replies());
    const initialTerm = (await status(leader)).term;
    for (const screen of screens) screen.sample.active = true;
    const lapIds = [];
    for (let i = 0; i < laps; i++) {
      await sleep(start + i * spacing - performance.now());
      const pressedAt = Date.now(),
        next = `bench-${i + 1}`;
      const result = await action(leader, 'race.handoff', {
        activeRunnerId: race.activeRunnerId,
        activeStartedAt: race.activeStartedAt,
        pressedAt,
        measuredDurationMs: 60001,
        nextRunnerId: next,
      });
      assert(result.lapId, 'handoff must add a lap');
      lapIds.push(result.lapId);
      race = { activeRunnerId: next, activeStartedAt: pressedAt };
    }
    await sleep(start + laps * spacing - performance.now());
    const bytesAfter = nodes.reduce((a, n) => a + n.egress, 0);
    const after = await cpu(nodes),
      elapsedMs = performance.now() - start;
    for (const screen of screens) screen.sample.active = false;
    const observations = [];
    assert.equal((await status(leader)).term, initialTerm, 'one Raft term throughout measurement');
    assert(nodes.reduce((a, n) => a + n.peerRequests, 0) > 0, 'proxy must observe signed inter-node requests');
    for (const [i, screen] of screens.entries()) {
      const renderer = await screen.page.evaluate(() => window.__runnerRenderer());
      assert.equal(renderer.kind, expectedRenderer);
      assert(screen.replies() > initialReplies[i], 'screen must retain real state polling');
      observations.push({
        ...screen.sample.initial,
        wasm: screen.sample.wasm,
        firstStateWire: screen.sample.firstStateWire,
        scopeEncoded: screen.sample.scopeEncoded,
        pushDecoded: screen.sample.pushDecoded / laps,
        pushStateWire: screen.sample.pushStateWire / laps,
        route: screen.route,
        node: screen.node,
        renderer,
        replies: screen.replies() - initialReplies[i],
      });
    }
    const replicas = [];
    for (const node of nodes) {
      const history = await json(node.url + '/api/history?scope=full');
      assert.equal(history.laps.length, n + laps);
      assert(
        lapIds.every((id) => history.laps.some((lap) => lap.id === id)),
        'exact lap replication'
      );
      replicas.push(history.laps.length);
    }
    const cpuMs = after.map((value, i) => value - before[i]);
    const idleCpuMsPerSecond = idleAfter.map((value, i) => ((value - idleBefore[i]) * 1000) / idleMs);
    const leaderIndex = nodes.indexOf(leader);
    const row = {
      n,
      pair,
      version,
      laps,
      elapsedMs,
      serverBytesPerSecond: ((bytesAfter - bytesBefore) * 1000) / elapsedMs,
      serverBytesPerLap: (bytesAfter - bytesBefore) / laps,
      peerRequests: nodes.reduce((a, n) => a + n.peerRequests, 0),
      leader: leader.name,
      leaderCpuPerLap: cpuMs[leaderIndex] / laps,
      clusterCpuPerLap: cpuMs.reduce((a, b) => a + b) / laps,
      cpuMs,
      idleCpuMsPerSecond,
      replicas,
      observations,
    };
    await writeFile(join(directory, 'result.json'), JSON.stringify(row, null, 2));
    return row;
  } finally {
    await browser?.close();
    await Promise.all(
      nodes.map(async (node) => {
        if (node.child && node.child.exitCode === null) {
          const exited = once(node.child, 'exit');
          node.child.kill('SIGTERM');
          await exited;
        }
        for (const socket of node.sockets ?? []) socket.destroy();
        if (node.proxy) await new Promise((r) => node.proxy.close(r));
        await writeFile(join(directory, node.name + '.log'), node.log);
      })
    );
  }
}
const rows = [];
for (const n of sizes)
  for (let pair = 0; pair < pairs; pair++) {
    for (const version of pair % 2 ? ['head', 'base'] : ['base', 'head']) {
      const row = await run(pair, version, n);
      rows.push(row);
      console.log(
        `${n} ${pair} ${version}: leader ${row.leaderCpuPerLap.toFixed(2)} cluster ${row.clusterCpuPerLap.toFixed(2)} CPU ms/lap`
      );
      await writeFile(join(out, 'results.json'), JSON.stringify(rows, null, 2));
    }
  }
if (pairs >= 2) {
  const summary = sizes.flatMap((n) =>
    ['leaderCpuPerLap', 'clusterCpuPerLap', 'serverBytesPerSecond', 'serverBytesPerLap'].map((metric) => {
      const samples = (version) => rows.filter((r) => r.n === n && r.version === version).map((r) => r[metric]);
      const base = samples('base'),
        head = samples('head');
      return {
        n,
        metric,
        base: median(base),
        head: median(head),
        percent: (median(head) / median(base) - 1) * 100,
        ci: pairedMedianCI(base, head),
      };
    })
  );
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
console.log(
  `PASS: ${rows.length} cluster runs, ${sizes.length} sizes, ${pairs} interleaved pairs, ${laps} laps/run; ten ${expectedRenderer} screens, exact lap replication on three Rust processes`
);
