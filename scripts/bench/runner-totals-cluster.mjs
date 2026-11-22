import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
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
    out: { type: 'string' },
    pairs: { type: 'string', default: '10' },
    laps: { type: 'string', default: '40' },
    spacing: { type: 'string', default: '1000' },
    renderer: { type: 'string', default: 'cpu' },
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
const seed = `
import sqlite3,json,sys,time
c=sqlite3.connect(sys.argv[1]); c.executescript(open(sys.argv[2]).read()); c.execute('PRAGMA user_version=17'); c.execute('INSERT INTO race_state(id) VALUES(1)'); now=int(time.time()*1000); start=now-3000*60001
for i in range(150):
 c.execute("INSERT INTO runners(id,runner_number,name,status,queue_index,status_since,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",(f'bench-{i}',str(i+1),f'Bench {i:03}', 'running' if i==0 else 'waiting',i,now-120000,now,now))
for i in range(3000):
 c.execute("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,?,?,?,?,?,?)",(f'seed-{i}',f'bench-{i%150}',i//150+1,start+i*60001,start+(i+1)*60001,60001,'spacebar',now,'[]'))
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
async function run(pair, version) {
  const directory = join(out, `${pair}-${version}`);
  await mkdir(directory, { recursive: true });
  const nodes = await Promise.all(
    ['A', 'B', 'C'].map(async (name) => {
      const p = await port();
      return { name, port: p, url: `http://127.0.0.1:${p}`, db: join(directory, name + '.db'), log: '' };
    })
  );
  execFileSync('python3', ['-c', seed, nodes[0].db, resolve('native/src/schema.sql')]);
  let browser;
  try {
    for (const node of nodes) {
      node.child = spawn(resolve(args[version]), ['--server'], {
        env: {
          ...process.env,
          PORT: String(node.port),
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
      '/queue',
      '/analysis',
      '/tactics',
      '/display/inside',
      '/display/competitions',
      '/display/outside',
    ].entries()) {
      const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      await page.addInitScript(rendererProbe, args.renderer === 'cpu');
      let replies = 0;
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/api/state' && response.ok()) replies++;
      });
      const node = nodes[Math.floor(i / 2)];
      await page.goto(node.url + route);
      await page.waitForFunction(
        (renderer) => window.__runnerRenderer().kind === renderer && document.querySelector('[data-rune-a11y]'),
        expectedRenderer,
        { timeout: 60000 }
      );
      screens.push({ page, route, node: node.name, replies: () => replies });
    }
    const initial = await json(leader.url + '/api/state');
    let race = initial.race;
    await sleep(3000);
    const idleBefore = await cpu(nodes),
      idleAt = performance.now();
    await sleep(5000);
    const idleAfter = await cpu(nodes),
      idleMs = performance.now() - idleAt;
    const before = await cpu(nodes),
      start = performance.now();
    const initialReplies = screens.map((s) => s.replies());
    const lapIds = [];
    for (let i = 0; i < laps; i++) {
      await sleep(start + i * spacing - performance.now());
      const pressedAt = Date.now(),
        next = `bench-${i + 1}`;
      const result = await action(leader, 'race.handoff', {
        activeRunnerId: race.activeRunnerId,
        activeStartedAt: race.activeStartedAt,
        pressedAt,
        nextRunnerId: next,
      });
      assert(result.lapId, 'handoff must add a lap');
      lapIds.push(result.lapId);
      race = { activeRunnerId: next, activeStartedAt: pressedAt };
    }
    await sleep(start + laps * spacing - performance.now());
    const after = await cpu(nodes),
      elapsedMs = performance.now() - start;
    const observations = [];
    for (const [i, screen] of screens.entries()) {
      const renderer = await screen.page.evaluate(() => window.__runnerRenderer());
      assert.equal(renderer.kind, expectedRenderer);
      assert(screen.replies() > initialReplies[i], 'screen must retain real state polling');
      observations.push({
        route: screen.route,
        node: screen.node,
        renderer,
        replies: screen.replies() - initialReplies[i],
      });
    }
    const replicas = [];
    for (const node of nodes) {
      const history = await json(node.url + '/api/history?scope=full');
      assert.equal(history.laps.length, 3000 + laps);
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
      pair,
      version,
      laps,
      elapsedMs,
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
        await writeFile(join(directory, node.name + '.log'), node.log);
      })
    );
  }
}
const rows = [];
for (let pair = 0; pair < pairs; pair++) {
  for (const version of pair % 2 ? ['head', 'base'] : ['base', 'head']) {
    const row = await run(pair, version);
    rows.push(row);
    console.log(
      `${pair} ${version}: leader ${row.leaderCpuPerLap.toFixed(2)} cluster ${row.clusterCpuPerLap.toFixed(2)} CPU ms/lap`
    );
    await writeFile(join(out, 'results.json'), JSON.stringify(rows, null, 2));
  }
}
if (pairs >= 2) {
  const summary = ['leaderCpuPerLap', 'clusterCpuPerLap'].map((metric) => {
    const samples = (version) => rows.filter((r) => r.version === version).map((r) => r[metric]);
    const base = samples('base'),
      head = samples('head');
    return {
      metric,
      base: median(base),
      head: median(head),
      percent: (median(head) / median(base) - 1) * 100,
      ci: pairedMedianCI(base, head),
    };
  });
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
console.log(
  `PASS: ${rows.length} cluster runs, ${pairs} interleaved pairs, ${laps} laps/run; six ${expectedRenderer} screens, exact lap replication on three Rust processes`
);
