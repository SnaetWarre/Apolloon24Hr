#!/usr/bin/env node
/*
 * Measures what the screens and the laptops send over the event network.
 *
 *   npm run build && npm run bench:network
 *   npm run bench:network -- --mbit=2 --writes=60 --json=out.json
 *   npm run bench:network -- --raft-only      (or --screens-only)
 *
 * Screens: real headless Chromium pages (2 Binnen/Buitenscherm, analysis,
 * tactics, timing, 2 queue) open on one built server through a proxy that
 * shares a fixed bandwidth among all of them, like a cheap access point.
 * The timing desk presses on the server itself, like the Electron app does.
 * Every write is a lap or a runner sent back to the queue, as on race day,
 * against a 24-hour-sized race (about 1,200 laps).
 *
 * Reports bytes over the link while idle and per write, and per screen how
 * long after a press it had the new data (p50/p95/max). A second part runs
 * three clustered laptops behind counting proxies and reports their idle
 * replication traffic.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? 'true'];
  })
);
const MBIT = Number(args.mbit || 10);
const ONE_WAY_MS = Number(args.latency || 3);
/** Chromium CPU slowdown per screen, like a TV or an old laptop (1 = this machine). */
const CPU_SLOWDOWN = Number(args.cpu || 1);
const WRITES = Number(args.writes || 40);
const WRITE_EVERY_MS = Number(args.every || 2_000);
const IDLE_MS = Number(args.idle || 20_000);
const LAP_COPIES = Number(args.copies || 3);
const RAFT_SECONDS = Number(args['raft-seconds'] || 15);
const benchRoot = path.join(repoRoot, '.bench-data');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SCREENS = [
  { name: 'inside display', route: '/display/inside', needs: ['state', 'history'] },
  { name: 'outside display', route: '/display/outside', needs: ['state', 'history'] },
  { name: 'analysis', route: '/analysis', needs: ['state', 'history'] },
  { name: 'tactics', route: '/tactics', needs: ['state', 'history'] },
  { name: 'timing', route: '/timing', needs: ['state', 'recent'] },
  { name: 'queue 1', route: '/queue', needs: ['state', 'registrations'] },
  { name: 'queue 2', route: '/queue', needs: ['state', 'registrations'] },
];

// Bandwidth-limited proxy: one queue per direction, shared by every connection.

function createLink(targetPort, { mbit = Infinity, oneWayMs = 0 } = {}) {
  const bytesPerMs = (mbit * 1_000_000) / 8 / 1_000;
  const counters = { up: 0, down: 0 };
  const lanes = { up: 0, down: 0 };
  const sockets = new Set();

  function send(direction, socket, chunk) {
    counters[direction] += chunk.length;
    if (!Number.isFinite(mbit)) {
      if (oneWayMs) setTimeout(() => socket.destroyed || socket.write(chunk), oneWayMs);
      else if (!socket.destroyed) socket.write(chunk);
      return;
    }
    // Split into frames so one large body does not block small ones for its whole length.
    for (let offset = 0; offset < chunk.length; offset += 1_460) {
      const frame = chunk.subarray(offset, offset + 1_460);
      const now = performance.now();
      lanes[direction] = Math.max(lanes[direction], now) + frame.length / bytesPerMs;
      setTimeout(() => socket.destroyed || socket.write(frame), lanes[direction] - now + oneWayMs);
    }
  }

  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    sockets.add(client).add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.on('data', (chunk) => send('up', upstream, chunk));
    upstream.on('data', (chunk) => send('down', client, chunk));
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('close', close).on('error', close);
    upstream.on('close', close).on('error', close);
  });
  return {
    counters,
    reset() {
      counters.up = 0;
      counters.down = 0;
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

// Data: the large seed, its laps copied back in time until it is a full race.

function prepareData(dataPath) {
  fs.rmSync(dataPath, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/seed-test-db.mjs',
      '--scenario=large',
      `--data-path=${path.relative(repoRoot, dataPath)}`,
    ],
    { cwd: repoRoot, stdio: 'ignore' }
  );
  const db = new DatabaseSync(path.join(dataPath, 'data', 'app.db'));
  const laps = db.prepare('SELECT * FROM laps').all();
  const first = Math.min(...laps.map((lap) => lap.started_at));
  const last = Math.max(...laps.map((lap) => lap.finished_at));
  const span = last - first;
  const insert = db.prepare(
    'INSERT INTO laps (id, runner_id, lap_number, started_at, finished_at, duration_ms, source, created_at, labels_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  db.exec('BEGIN');
  for (let copy = 1; copy <= LAP_COPIES; copy += 1) {
    for (const lap of laps) {
      const shift = span * copy;
      insert.run(
        randomUUID(),
        lap.runner_id,
        lap.lap_number,
        lap.started_at - shift,
        lap.finished_at - shift,
        lap.duration_ms,
        lap.source,
        lap.created_at - shift,
        lap.labels_json
      );
    }
  }
  db.prepare('UPDATE race_state SET race_started_at = ? WHERE id = 1').run(first - span * LAP_COPIES);
  db.exec('COMMIT');
  const count = db.prepare('SELECT COUNT(*) AS count FROM laps').get().count;
  db.close();
  return count;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startServer(dataPath, port, extraEnv = {}) {
  const logPath = path.join(dataPath, 'server.log');
  fs.mkdirSync(dataPath, { recursive: true });
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, ['dist-server/server/index.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      PUBLIC_APP_PORT: String(port),
      DATA_PATH: dataPath,
      BACKUP_ENABLED: 'false',
      ...extraEnv,
    },
    stdio: ['ignore', log, log],
  });
  return child;
}

async function waitUntilUp(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await fetch(`${url}/api/host-info`).catch(() => null))?.ok) return;
    await sleep(200);
  }
  throw new Error(`${url} did not start`);
}

async function mutate(url, procedure, input) {
  const response = await fetch(`${url}/trpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? null),
  });
  const payload = await response.json();
  if (!payload.result) throw new Error(`${procedure}: ${JSON.stringify(payload.error?.message ?? payload)}`);
  return payload.result.data;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function kind(url) {
  const { pathname, searchParams } = new URL(url);
  if (pathname === '/api/state') return 'state';
  if (pathname === '/api/history') {
    if (searchParams.get('scope') === 'recent') return 'recent';
    if (searchParams.get('runnerId')) return 'runner';
    return 'history';
  }
  if (pathname.includes('registrations')) return 'registrations';
  if (pathname.includes('cluster/status')) return 'cluster';
  return null;
}

// Screens.

async function benchScreens() {
  const { chromium } = await import('playwright');
  const dataPath = path.join(benchRoot, 'screens');
  const lapCount = prepareData(dataPath);
  const port = await freePort();
  const direct = `http://127.0.0.1:${port}`;
  const server = startServer(dataPath, port);
  const link = createLink(port, { mbit: MBIT, oneWayMs: ONE_WAY_MS });
  const browser = await chromium.launch();
  try {
    await waitUntilUp(direct);
    const proxied = `http://127.0.0.1:${await link.listen()}`;
    const screens = [];
    for (const definition of SCREENS) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      if (CPU_SLOWDOWN > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
      const screen = { ...definition, page, cdp, revisions: [], requests: [] };
      const started = new WeakMap();
      page.on('websocket', (socket) =>
        socket.on('framereceived', ({ payload }) => {
          let message = null;
          try {
            message = JSON.parse(String(payload));
          } catch {
            return; // Keep-alive PING/PONG.
          }
          const revision = message?.result?.data;
          if (typeof revision === 'number') screen.revisions.push({ at: performance.now(), revision });
        })
      );
      page.on('request', (request) => {
        const type = kind(request.url());
        if (type) started.set(request, { type, startedAt: performance.now() });
      });
      page.on('requestfinished', (request) => {
        const entry = started.get(request);
        if (entry) screen.requests.push({ ...entry, finishedAt: performance.now() });
      });
      const loadStartedAt = performance.now();
      const bytesBefore = link.counters.down;
      await page.goto(`${proxied}${definition.route}`, { waitUntil: 'load', timeout: 120_000 });
      // Loaded once every request the screen needs for its data has finished.
      const deadline = Date.now() + 60_000;
      while (!definition.needs.every((type) => screen.requests.some((request) => request.type === type))) {
        if (Date.now() > deadline) throw new Error(`${definition.name} never loaded its data`);
        await sleep(20);
      }
      screen.loadMs = Math.max(...screen.requests.map((request) => request.finishedAt)) - loadStartedAt;
      await sleep(1_000);
      screen.loadBytes = link.counters.down - bytesBefore;
      screens.push(screen);
    }
    await sleep(8_000);

    const mainThread = async () =>
      Promise.all(
        screens.map(async (screen) => {
          const { metrics } = await screen.cdp.send('Performance.getMetrics');
          return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
        })
      );
    link.reset();
    for (const screen of screens) screen.requests.length = 0;
    const idleCpuBefore = await mainThread();
    await sleep(IDLE_MS);
    const idleCpuAfter = await mainThread();
    const idle = { ...link.counters };
    const idleRequests = Object.fromEntries(screens.map((screen) => [screen.name, screen.requests.length]));

    link.reset();
    const writeCpuBefore = await mainThread();
    const presses = [];
    const phaseStartedAt = performance.now();
    let lastFinisher = null;
    for (let index = 0; index < WRITES; index += 1) {
      const nextAt = phaseStartedAt + index * WRITE_EVERY_MS;
      await sleep(Math.max(0, nextAt - performance.now()));
      if (index % 2 === 0) {
        const state = await (await fetch(`${direct}/api/state`)).json();
        lastFinisher = state.race.activeRunnerId;
        const waiting = state.runners.filter((runner) => runner.status === 'waiting');
        if (!waiting.length) {
          const candidate = state.runners.find((runner) => runner.status !== 'running');
          await mutate(direct, 'runners.setStatus', { id: candidate.id, status: 'waiting' });
        }
        const race = (await (await fetch(`${direct}/api/state`)).json()).race;
        const pressAt = performance.now();
        await mutate(direct, 'race.handoff', {
          activeRunnerId: race.activeRunnerId,
          activeStartedAt: race.activeStartedAt,
        });
        presses.push({ type: 'lap', at: pressAt, tookMs: performance.now() - pressAt });
      } else {
        const pressAt = performance.now();
        await mutate(direct, 'runners.setStatus', { id: lastFinisher, status: 'waiting' });
        presses.push({ type: 'queue', at: pressAt, tookMs: performance.now() - pressAt });
      }
    }
    await sleep(Math.max(6_000, WRITE_EVERY_MS * 2));
    const writing = { ...link.counters };
    const writingMs = performance.now() - phaseStartedAt;
    const writeCpuAfter = await mainThread();

    const perScreen = screens.map((screen, screenIndex) => {
      // Main-thread busy time (TaskDuration, seconds, slowed down like the device).
      const busy = (after, before) => after[screenIndex].TaskDuration - before[screenIndex].TaskDuration;
      const idleBusyPerMs = busy(idleCpuAfter, idleCpuBefore) / IDLE_MS;
      const writeBusy = busy(writeCpuAfter, writeCpuBefore) - idleBusyPerMs * writingMs;
      const latencies = [];
      for (const [index, press] of presses.entries()) {
        const until = presses[index + 1]?.at ?? Infinity;
        const announced = screen.revisions.find((entry) => entry.at >= press.at && entry.at < until);
        if (!announced) continue;
        let fresh = 0;
        for (const type of screen.needs) {
          const done = screen.requests.find((request) => request.type === type && request.startedAt >= announced.at);
          if (!done) {
            fresh = null;
            break;
          }
          fresh = Math.max(fresh, done.finishedAt - press.at);
        }
        if (fresh !== null) latencies.push(fresh);
      }
      return {
        screen: screen.name,
        updates: latencies.length,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        max: percentile(latencies, 100),
        idleRequestsPerMinute: (idleRequests[screen.name] * 60_000) / IDLE_MS,
        loadMs: screen.loadMs,
        loadKb: screen.loadBytes / 1024,
        idleCpuPercent: idleBusyPerMs * 1_000 * 100,
        cpuMsPerWrite: (writeBusy * 1_000) / presses.length,
      };
    });
    const writingNet = {
      up: writing.up - (idle.up * writingMs) / IDLE_MS,
      down: writing.down - (idle.down * writingMs) / IDLE_MS,
    };
    return {
      lapCount,
      mbit: MBIT,
      cpuSlowdown: CPU_SLOWDOWN,
      writes: presses.length,
      idleBytesPerSecond: { up: (idle.up * 1_000) / IDLE_MS, down: (idle.down * 1_000) / IDLE_MS },
      bytesPerWrite: { up: writingNet.up / presses.length, down: writingNet.down / presses.length },
      writePhaseBytesPerSecond: { up: (writing.up * 1_000) / writingMs, down: (writing.down * 1_000) / writingMs },
      pressMs: {
        p50: percentile(
          presses.map((press) => press.tookMs),
          50
        ),
        p95: percentile(
          presses.map((press) => press.tookMs),
          95
        ),
      },
      screens: perScreen,
    };
  } finally {
    await browser.close();
    link.close();
    server.kill('SIGTERM');
  }
}

// Laptops: idle replication traffic between three clustered servers.

async function benchRaft() {
  const discoveryPort = 20_000 + (process.pid % 20_000);
  const laptops = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const dataPath = path.join(benchRoot, `raft-${index}`);
      fs.rmSync(dataPath, { recursive: true, force: true });
      const port = await freePort();
      const link = createLink(port);
      const url = `http://127.0.0.1:${await link.listen()}`;
      const child = startServer(dataPath, port, {
        CLUSTER_ENABLED: 'true',
        CLUSTER_SELF_URL: url,
        CLUSTER_DISCOVERY_ADDRESS: '127.255.255.255',
        CLUSTER_DISCOVERY_PORT: String(discoveryPort),
        APOLLOON_APP_VERSION: '0.0.0-bench',
      });
      laptops.push({ url, link, child, direct: `http://127.0.0.1:${port}` });
    }
    for (const laptop of laptops) await waitUntilUp(laptop.direct);
    for (const laptop of laptops.slice(1)) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await mutate(laptop.direct, 'cluster.join', { url: laptops[0].url });
          break;
        } catch (error) {
          if (attempt > 20) throw error;
          await sleep(500);
        }
      }
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const status = await (await fetch(`${laptops[0].direct}/api/cluster/status`)).json();
      if (status.state === 'healthy') break;
      await sleep(250);
    }
    await sleep(3_000);
    for (const laptop of laptops) laptop.link.reset();
    await sleep(RAFT_SECONDS * 1_000);
    const total = laptops.reduce((sum, laptop) => sum + laptop.link.counters.up + laptop.link.counters.down, 0);
    return { laptops: 3, bytesPerSecond: total / RAFT_SECONDS };
  } finally {
    for (const laptop of laptops) {
      laptop.child.kill('SIGTERM');
      laptop.link.close();
    }
  }
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function ms(value) {
  return value === null ? '-' : `${Math.round(value)} ms`;
}

const result = {};
if (args['raft-only'] !== 'true') result.screens = await benchScreens();
if (args['screens-only'] !== 'true') result.raft = await benchRaft();
fs.rmSync(benchRoot, { recursive: true, force: true });

if (result.screens) {
  const s = result.screens;
  console.log(
    `\nScreens: ${SCREENS.length} browsers, ${s.lapCount} laps, ${s.mbit} Mbit/s shared link, ${s.writes} writes`
  );
  console.log(`  idle:      ${kb(s.idleBytesPerSecond.down)}/s down, ${kb(s.idleBytesPerSecond.up)}/s up`);
  console.log(`  per write: ${kb(s.bytesPerWrite.down)} down, ${kb(s.bytesPerWrite.up)} up`);
  console.log(`  press answered: p50 ${ms(s.pressMs.p50)}, p95 ${ms(s.pressMs.p95)}`);
  console.log('  press to screen updated:');
  for (const screen of s.screens) {
    console.log(
      `    ${screen.screen.padEnd(16)} p50 ${ms(screen.p50).padStart(7)}  p95 ${ms(screen.p95).padStart(7)}  max ${ms(screen.max).padStart(7)}  (${screen.updates} updates, ${screen.idleRequestsPerMinute.toFixed(0)} idle requests/min)`
    );
  }
  console.log(`  main thread (CPU ${s.cpuSlowdown}x slower than this machine) and first load:`);
  for (const screen of s.screens) {
    console.log(
      `    ${screen.screen.padEnd(16)} idle ${screen.idleCpuPercent.toFixed(1).padStart(5)}% busy  per write ${ms(screen.cpuMsPerWrite).padStart(7)}  first load ${ms(screen.loadMs).padStart(7)}, ${screen.loadKb.toFixed(0).padStart(4)} KB`
    );
  }
}
if (result.raft) console.log(`\nLaptops: 3 in a group, idle: ${kb(result.raft.bytesPerSecond)}/s between them`);
if (args.json) fs.writeFileSync(args.json, JSON.stringify(result, null, 2));
