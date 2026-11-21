// Real Rune surfaces, disposable data. See README.md for measurement boundaries.
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { browserLatencies, nativeLatencies, percentile, validateReplicaLaps } from './metrics.mjs';
import { installBrowserTrace, stageMetrics, stageMarkdown } from './latency.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const followers = process.argv.includes('--followers');
const setupOnly = process.argv.includes('--setup-only');
const trace = process.argv.includes('--trace') || process.env.APOLLOON_LATENCY_TRACE === '1';
const traceEvents = [];
const pressCount = 15;
const spacingMs = 21000;
const out = path.resolve('.tmp-bench', new Date().toISOString().replaceAll(':', '-'));
await mkdir(out, { recursive: true });
const binary = path.resolve('native/target/release/apolloon-native');
const children = [],
  proxies = [],
  traffic = [],
  nativeEvents = [];
let browser,
  measuring = false;
function launch(command, args, env = {}, name = 'process') {
  const child = spawn(command, args, {
    env: { ...process.env, APOLLOON_LATENCY_TRACE: trace ? '1' : '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += chunk;
  });
  child.stderr.on('data', (chunk) => {
    log += chunk;
  });
  if (trace) {
    let pending = '';
    child.stderr.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith('APOLLOON_LATENCY ')) traceEvents.push({ ...JSON.parse(line.slice(17)), source: name });
      }
    });
  }
  child.on('error', (error) => {
    log += error.stack;
  });
  child.saveLog = () => writeFile(path.join(out, name + '.log'), log);
  return child;
}
async function eventually(fn, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await sleep(100);
  }
  throw new Error('Timed out: ' + description);
}
async function port() {
  const s = netServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const value = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return value;
}
async function json(url, method, input) {
  const response = await fetch(
    url,
    input === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
  );
  if (!response.ok) throw new Error(`${method}: ${response.status} ${await response.text()}`);
  return response.json();
}
const action = (node, method, input) => json(node.url + '/api/action/' + method, method, input);
const status = (node) => json(node.url + '/api/cluster/status');
async function start(node, linked) {
  node.child = launch(
    binary,
    ['--server'],
    {
      PORT: String(node.port),
      APOLLOON_NATIVE_DATA: node.db,
      CLUSTER_ENABLED: String(linked),
      CLUSTER_DISCOVERY: 'false',
      CLUSTER_AUTO_LINK: 'false',
      CLUSTER_SELF_URL: node.url,
      CLUSTER_LAPTOP_NAME: node.name,
      BACKUP_ENABLED: 'false',
    },
    node.name + (linked ? '' : '-init')
  );
  await eventually(() => fetch(node.url + '/api/health').then((r) => r.ok), node.name + ' health');
}
async function proxy(node) {
  const server = createServer((req, res) => {
    const at = Date.now(),
      counted = measuring;
    const upstream = httpRequest(node.url + req.url, { method: req.method, headers: req.headers }, (reply) => {
      let bytes = 0;
      res.writeHead(reply.statusCode, reply.headers);
      reply.on('data', (chunk) => {
        bytes += chunk.length;
      });
      reply.on('end', () => {
        if (counted) traffic.push({ at, node: node.name, path: req.url, bytes, status: reply.statusCode });
      });
      reply.pipe(res);
    });
    upstream.on('error', (error) => {
      res.writeHead(502);
      res.end(error.message);
    });
    req.pipe(upstream);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  proxies.push(server);
  return 'http://127.0.0.1:' + server.address().port;
}
const seed = `
import sqlite3,json,sys,time
c=sqlite3.connect(sys.argv[1]); now=int(time.time()*1000); start=now-2240*60000
labels=[dict(id=r[0],name=r[1],color=r[2],icon=r[3],kind=r[4]) for r in c.execute('SELECT id,name,color,icon,kind FROM labels ORDER BY sort_order LIMIT 2')]
assert len(labels)==2
for i in range(40):
 c.execute('INSERT INTO runners(id,runner_number,name,status,queue_index,status_since,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',(f'bench-{i}',str(i+1),f'Bench {i:02}', 'running' if i==0 else 'waiting',i,now,now,now))
 c.execute('INSERT INTO runner_labels VALUES(?,?)',(f'bench-{i}',labels[0]['id']))
for i in range(2240):
 c.execute('INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,?,?,?,?,?,?)',(f'seed-{i}',f'bench-{i%40}',i//40+1,start+i*60000,start+i*60000+20000,20000,'timing',now,json.dumps([labels[0]])))
c.execute('UPDATE race_state SET active_runner_id=?,active_started_at=?,race_started_at=?,race_finished_at=NULL,active_labels_json=? WHERE id=1',('bench-0',now-120000,start,json.dumps([labels[0]])))
c.execute("INSERT OR REPLACE INTO settings VALUES('competitions_json',?)",(json.dumps([[l['id'] for l in labels]]),))
c.commit()
`;
try {
  try {
    await readFile(binary);
    await readFile('native/web-dist/index.html');
  } catch {
    execFileSync('bash', ['native/scripts/build-web.sh'], { stdio: 'inherit' });
    execFileSync(
      'cargo',
      ['build', '--release', '--locked', '--manifest-path', 'native/Cargo.toml', '--bin', 'apolloon-native'],
      { stdio: 'inherit' }
    );
  }
  const nodes = await Promise.all(
    ['A', 'B', 'C'].map(async (name) => {
      const p = await port();
      return { name, port: p, url: 'http://127.0.0.1:' + p, db: path.join(out, name + '.db') };
    })
  );
  await start(nodes[0], false);
  nodes[0].child.kill();
  await once(nodes[0].child, 'exit');
  execFileSync('python3', ['-c', seed, nodes[0].db]);
  await Promise.all(nodes.map((node) => start(node, true)));
  for (const node of nodes.slice(1)) {
    await action(node, 'cluster.joinGroup', { url: nodes[0].url });
    await eventually(async () => {
      const s = await status(nodes[0]);
      return s.writable && !s.busy && s.members.length === nodes.indexOf(node) + 1;
    }, 'join ' + node.name);
  }
  await eventually(async () => {
    const states = await Promise.all(nodes.map(status));
    return states.every((s) => s.writable && !s.busy && s.members.length === 3 && s.logHead === states[0].logHead);
  }, 'cluster convergence');
  const leader = await eventually(async () => {
    for (const node of nodes) if ((await status(node)).role === 'leader') return node;
  }, 'leader');
  await action(leader, 'cluster.openTiming', { takeOver: true });
  const origins = new Map(await Promise.all(nodes.map(async (n) => [n, await proxy(n)])));
  const other = nodes.filter((n) => n !== leader);
  browser = await chromium.launch({
    headless: false,
    args: [
      '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--window-position=1400,0',
    ],
  });
  const routes = ['/display/inside', '/display/competitions', '/display/outside', '/queue', '/timing'];
  const screens = [];
  for (const [i, route] of routes.entries()) {
    const node = followers ? other[i % other.length] : leader;
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark' });
    const page = await context.newPage();
    await page.addInitScript(installBrowserTrace, trace);
    await page.addInitScript(() => {
      window.benchFrames = [];
      let previous = '';
      const capture = () => {
        const root = document.querySelector('[data-rune-a11y]');
        if (!root) return;
        const leaves = [...root.querySelectorAll('*')].filter((e) => !e.children.length);
        const text = leaves.map((e) => e.textContent).join('|');
        const regions = [...root.querySelectorAll('[role="region"]')].map((e) => ({
          label: e.getAttribute('aria-label'),
          text: e.textContent,
        }));
        if (text !== previous) {
          window.benchFrames.push({ at: performance.timeOrigin + performance.now(), text, regions });
          previous = text;
        }
      };
      new MutationObserver(capture).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await page.goto(origins.get(node) + route);
    await page.waitForFunction(
      () => document.querySelector('[data-rune-a11y]') && !document.querySelector('#status'),
      null,
      { timeout: 120000 }
    );
    screens.push({ name: route, node: node.name, page });
    await page.screenshot({ path: path.join(out, route.split('/').at(-1) + '-before.png') });
  }
  const native = launch(
    binary,
    [],
    {
      APOLLOON_NATIVE_URL: origins.get(leader),
      APOLLOON_NATIVE_PAGE: '2',
      APOLLOON_NATIVE_THEME: 'dark',
      DISPLAY: process.env.DISPLAY ?? ':0',
    },
    'native'
  );
  const windowId = await eventually(() => {
    const ids = execFileSync('xdotool', ['search', '--onlyvisible', '--pid', String(native.pid)], { encoding: 'utf8' })
      .trim()
      .split('\n');
    return ids[0];
  }, 'native window');
  execFileSync('xdotool', [
    'windowmove',
    windowId,
    '0',
    '0',
    'windowsize',
    windowId,
    '1366',
    '768',
    'windowraise',
    windowId,
  ]);
  await sleep(2000);
  execFileSync('xdotool', ['mousemove', '--window', windowId, '80', '178', 'click', '1']);
  await sleep(5000);
  execFileSync('import', ['-window', windowId, path.join(out, 'native-before.png')]);
  // Attached native app has the same content layout as browser Timing. Locate the static total digits.
  const timing = followers
    ? await browser.newPage({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark' })
    : screens.at(-1).page;
  if (followers) {
    await timing.goto(origins.get(leader) + '/timing');
    await timing.waitForFunction(() =>
      [...document.querySelectorAll('[data-rune-a11y] *')].some((e) => !e.children.length && e.textContent === '2240')
    );
  }
  const rect = await timing.evaluate(() => {
    const leaf = [...document.querySelectorAll('[data-rune-a11y] *')].find(
      (e) => !e.children.length && e.textContent === 'Rondes in de race'
    );
    if (!leaf) throw new Error('Timing lap-total label missing');
    const value = [...leaf.parentElement.querySelectorAll('*')].find(
      (e) => !e.children.length && e.textContent === '2240'
    );
    if (!value) throw new Error('Timing lap-total value missing');
    const r = value.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (followers) await timing.close();
  const geometry = execFileSync('xdotool', ['getwindowgeometry', '--shell', windowId], { encoding: 'utf8' });
  const xy = Object.fromEntries(
    geometry
      .trim()
      .split('\n')
      .map((line) => line.split('='))
  );
  const roi = [
    Math.round(rect.x) + Number(xy.X),
    Math.round(rect.y) + Number(xy.Y),
    Math.ceil(rect.width),
    Math.ceil(rect.height),
  ];
  await mkdir(path.join(out, 'native-frames'));
  const sampler = launch(
    'python3',
    ['scripts/bench/native-sampler.py', ...roi.map(String), path.join(out, 'native-frames')],
    {},
    'sampler'
  );
  let buffer = '';
  sampler.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) nativeEvents.push(JSON.parse(line));
  });
  await eventually(() => nativeEvents.length, 'native sampler');
  await writeFile(
    path.join(out, 'setup.json'),
    JSON.stringify(
      { roi, rect, leader: leader.name, nodes, followers },
      (key, value) => (key === 'child' ? undefined : value),
      2
    )
  );
  console.log('Ready:', out, 'native ROI', roi);
  if (setupOnly) {
    await sleep(30000);
    throw new Error('Setup-only: measurement not requested');
  }
  await sleep(2000);
  const writes = [];
  const replicaChecks = [];
  const initialIds = (await json(leader.url + '/api/history?scope=full')).laps.map((lap) => lap.id);
  if (initialIds.length !== 2240) throw new Error('Expected 2240 seeded laps');
  const checkReplicas = async (expectedAdded) => {
    let lastCounts;
    const ids = await eventually(
      async () => {
        const histories = await Promise.all(nodes.map((n) => json(n.url + '/api/history?scope=full')));
        lastCounts = histories.map((h) => h.laps.length);
        return validateReplicaLaps(histories, initialIds, expectedAdded);
      },
      `exactly ${expectedAdded} added laps on all replicas`,
      5000
    );
    replicaChecks.push({ at: Date.now(), expectedAdded, counts: lastCounts, addedIds: ids });
    return ids;
  };
  await checkReplicas(0);
  execFileSync('xdotool', ['windowfocus', '--sync', windowId]);
  execFileSync('xdotool', ['mousemove', '--window', windowId, '700', '40', 'click', '1']);
  const pressSpace = () => {
    const sentAt = Date.now();
    execFileSync('xdotool', ['key', '--window', windowId, '--clearmodifiers', 'space']);
    return sentAt;
  };
  const startAt = Date.now();
  measuring = true;
  for (let i = 0; i < pressCount; i++) {
    await sleep((writes.at(-1)?.sentAt ?? startAt - spacingMs) + spacingMs - Date.now());
    const sentAt = pressSpace();
    const ids = await checkReplicas(i + 1);
    const priorIds = new Set(replicaChecks.at(-2).addedIds);
    const [lapId] = ids.filter((id) => !priorIds.has(id));
    writes.push({
      i,
      sentAt,
      acknowledgedAt: Date.now(),
      total: 2241 + i,
      active: `Bench ${String(i + 1).padStart(2, '0')}`,
      lapId,
    });
    console.log(`Press ${i + 1}/${pressCount}: exactly one lap on A/B/C`);
  }
  await eventually(() => nativeEvents.find((e) => e.hash && e.at >= writes.at(-1).sentAt), 'last lap pixels', 5000);
  await sleep(100);
  const endAt = Date.now();
  measuring = false;
  const beforeRapid = nativeEvents.filter((e) => e.hash).at(-1);
  await sleep(Math.max(0, beforeRapid.at + 300 - Date.now()));
  const rapidAt = pressSpace();
  await eventually(() => nativeEvents.find((e) => e.hash && e.at > rapidAt), 'short-lap modal pixel change', 3000);
  await sleep(800);
  await checkReplicas(pressCount);
  execFileSync('import', [
    '-window',
    'root',
    '-crop',
    `1366x768+${xy.X}+${xy.Y}`,
    path.join(out, 'native-short-lap-modal.png'),
  ]);
  execFileSync('xdotool', ['key', '--window', windowId, 'Escape']);
  await eventually(
    () => nativeEvents.find((e) => e.hash === beforeRapid.hash && e.at > rapidAt),
    'dismissed modal restores lap pixels',
    3000
  );
  await checkReplicas(pressCount);
  const handoffRequests = traffic.filter((r) => r.path === '/api/action/race.handoff');
  if (handoffRequests.length !== pressCount)
    throw new Error('Expected exactly one native HTTP handoff per measured press');
  const doublePress = {
    rapidAt,
    msAfterLastLapPixel: rapidAt - beforeRapid.at,
    noAdditionalLap: true,
    lapPixelsRestoredAfterEscape: true,
    modalScreenshot: 'native-short-lap-modal.png',
    modalTextRequiresVisualReview: true,
  };
  sampler.kill();
  execFileSync('import', ['-window', windowId, path.join(out, 'native-after.png')]);
  const results = [];
  const refresh = [];
  for (const screen of screens) {
    const frames = await screen.page.evaluate(() => window.benchFrames);
    await writeFile(path.join(out, screen.name.split('/').at(-1) + '-frames.json'), JSON.stringify(frames));
    await screen.page.screenshot({ path: path.join(out, screen.name.split('/').at(-1) + '-after.png') });
    const values = browserLatencies(screen.name, frames, writes);
    results.push({ name: screen.name, node: screen.node, values });
    if (trace) {
      const timing = await screen.page.evaluate(() => ({
        events: window.apolloonLatencyEvents,
        intervals: window.apolloonRefreshIntervals,
        clockResolutionUs: window.apolloonClockResolutionUs,
      }));
      traceEvents.push(...timing.events.map((e) => ({ ...e, source: screen.name })));
      refresh.push({ screen: screen.name, intervals: timing.intervals, clockResolutionUs: timing.clockResolutionUs });
    }
  }
  const changes = nativeEvents.filter((e) => e.hash && e.at >= startAt && e.at <= endAt);
  const nativeValues = nativeLatencies(changes, writes, endAt);
  results.unshift({ name: 'native Timing', node: leader.name, values: nativeValues });
  for (const r of results) {
    r.observed = r.values.filter((v) => v !== null).length;
    r.p50 = percentile(
      r.values.filter((v) => v !== null),
      0.5
    );
    r.p95 = percentile(
      r.values.filter((v) => v !== null),
      0.95
    );
    r.max = percentile(
      r.values.filter((v) => v !== null),
      1
    );
    r.signal = r.name === 'native Timing' ? 'X11 lap-total pixels' : 'Rune accessibility mirror (not pixels)';
  }
  const seconds = (endAt - startAt) / 1000;
  const rates = Object.fromEntries(
    ['/api/state', '/api/history'].map((endpoint) => {
      const requests = traffic.filter((r) => r.path.split('?')[0] === endpoint);
      return [
        endpoint,
        {
          count: requests.length,
          reqPerSecond: requests.length / seconds,
          bytes: requests.reduce((n, r) => n + r.bytes, 0),
          bytesPerSecond: requests.reduce((n, r) => n + r.bytes, 0) / seconds,
        },
      ];
    })
  );
  const summary = {
    out,
    followers,
    startAt,
    endAt,
    seconds,
    writes,
    replicaChecks,
    doublePress,
    results,
    rates,
    trafficPerSecond: Array.from({ length: Math.ceil(seconds) }, (_, second) => ({
      second,
      ...Object.fromEntries(
        ['/api/state', '/api/history'].map((endpoint) => {
          const rows = traffic.filter(
            (r) => r.path.split('?')[0] === endpoint && Math.floor((r.at - startAt) / 1000) === second
          );
          return [endpoint, { requests: rows.length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0) }];
        })
      ),
    })),
    overallP50: percentile(
      results.flatMap((r) => r.values).filter((v) => v !== null),
      0.5
    ),
    overallMax: percentile(
      results.flatMap((r) => r.values).filter((v) => v !== null),
      1
    ),
    overallP95: percentile(
      results.flatMap((r) => r.values).filter((v) => v !== null),
      0.95
    ),
    nativeMaxSampleGapMs: Math.max(...nativeEvents.map((e) => e.maxGapMs)),
    roi,
    environment: {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      browser: browser.version(),
      platform: os.platform(),
      cpus: os.cpus().length,
      cpu: os.cpus()[0].model,
      display: process.env.DISPLAY,
    },
    valid: results.every((r) => r.observed === pressCount),
  };
  if (trace) {
    summary.latency = stageMetrics(traceEvents, writes, results, leader.name, refresh);
    const modes = execFileSync('xrandr', ['--current'], { encoding: 'utf8' });
    const hz = Number(modes.match(/([\d.]+)\*\+?/)?.[1]);
    summary.latency.reportedDisplayHz = hz || null;
    summary.latency.reportedRefreshPeriodUs = hz ? 1_000_000 / hz : null;
    await writeFile(path.join(out, 'latency-events.json'), JSON.stringify(traceEvents));
  }
  const markdown =
    `# Six-screen native-Space baseline\n\n${out}\n\nNative = pixels; browsers = Rune accessibility mirror, NOT pixels.\n\n| Screen | n/${pressCount} | p50 ms | p95 ms | max ms |\n|---|---:|---:|---:|---:|\n` +
    results.map((r) => `| ${r.name} | ${r.observed} | ${r.p50} | ${r.p95} | ${r.max} |`).join('\n') +
    `\n\nOverall p50/p95/max: ${summary.overallP50}/${summary.overallP95}/${summary.overallMax} ms. Valid: ${summary.valid}. Window: ${seconds}s.\n\n` +
    `All three replicas: ${pressCount} unique new lap IDs, one per measured press, seeded laps preserved. Rapid second press: no lap; modal dismissed. Review native-short-lap-modal.png.\n\n` +
    Object.entries(rates)
      .map(
        ([name, r]) =>
          `${name}: ${r.reqPerSecond.toFixed(2)} req/s, ${r.bytesPerSecond.toFixed(0)} encoded body bytes/s`
      )
      .join('\n\n') +
    `\n\nNative 5ms target sampler maximum gap: ${summary.nativeMaxSampleGapMs.toFixed(2)}ms.\n` +
    (trace ? stageMarkdown(summary.latency) : '');
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(out, 'summary.md'), markdown);
  await writeFile(path.join(out, 'traffic.json'), JSON.stringify(traffic));
  await writeFile(path.join(out, 'native-events.json'), JSON.stringify(nativeEvents));
  console.log(markdown);
  if (!summary.valid) process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children) {
    if (child.exitCode === null) child.kill();
    await child.saveLog();
  }
  for (const server of proxies) {
    server.closeAllConnections();
    server.close();
  }
}
