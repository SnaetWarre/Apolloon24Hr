#!/usr/bin/env node
/*
 * Measures how long a browser screen is without a working laptop when its
 * laptop dies, on three real servers linked into one group.
 *
 *   npm run build && npm run bench:failover
 *   npm run bench:failover -- --rounds=5 --json=out.json
 *
 * A Buitenscherm (TV) and a browser operator (queue desk) are open on one
 * laptop; then that laptop
 *   crashes:  the app stops, the laptop still answers "nobody here" at once;
 *   freezes:  no answer at all, like a power cut, a pulled cable or a closed lid;
 * once while it leads the group and once while it follows. The time runs
 * from the fault until the screen shows its page from another laptop; for
 * comparison, "the other laptops" is when a laptop with a working leader
 * first says it lost that laptop.
 *
 * Short hiccups (the laptop freezes for a moment and comes back) must not
 * move a screen: the report says how many hiccups of each length did.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? 'true'];
  })
);
const ROUNDS = Number(args.rounds || 3);
const HICCUPS_MS = (args.hiccups || '1000,2000,3000').split(',').map(Number).filter(Boolean);
/** Give up on a screen after this long; it counts as "never switched". */
const GIVE_UP_MS = Number(args['give-up'] || 60_000);
const root = path.join(repoRoot, '.bench-data', 'failover');
const discoveryPort = 20_000 + (process.pid % 20_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BROWSER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const SCREENS = [
  { name: 'TV (Buitenscherm)', route: '/display/outside' },
  { name: 'browser operator (queue)', route: '/queue' },
];

// Laptops.

const laptops = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function launch(laptop) {
  const log = fs.openSync(laptop.logPath, 'a');
  laptop.child = spawn(process.execPath, [path.join(repoRoot, 'dist-server/server/index.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATA_PATH: laptop.dataPath,
      PORT: String(laptop.port),
      CLUSTER_ENABLED: 'true',
      CLUSTER_SELF_URL: laptop.url,
      CLUSTER_DISCOVERY_ADDRESS: '127.255.255.255',
      CLUSTER_DISCOVERY_PORT: String(discoveryPort),
      BACKUP_ENABLED: 'false',
    },
    stdio: ['ignore', log, log],
  });
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function status(laptop) {
  const response = await fetch(`${laptop.url}/api/cluster/status`, { signal: AbortSignal.timeout(2_000) });
  return response.json();
}

async function startGroup() {
  fs.rmSync(root, { recursive: true, force: true });
  for (const name of ['timing', 'desk', 'warmup']) {
    const port = await freePort();
    const laptop = {
      name,
      port,
      url: `http://127.0.0.1:${port}`,
      dataPath: path.join(root, name),
      logPath: path.join(root, `${name}.log`),
    };
    fs.mkdirSync(laptop.dataPath, { recursive: true });
    laptops.push(laptop);
  }
  execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/seed-test-db.mjs', '--scenario=live', `--data-path=${laptops[0].dataPath}`],
    { cwd: repoRoot, stdio: 'ignore' }
  );
  for (const laptop of laptops) {
    launch(laptop);
    await waitFor(async () => (await fetch(`${laptop.url}/api/host-info`)).ok, 20_000, `${laptop.name} to start`);
  }
  for (const laptop of laptops.slice(1)) {
    await waitFor(async () => Boolean((await status(laptops[0])).leader), 15_000, 'a leader');
    const response = await fetch(`${laptop.url}/trpc/cluster.join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: laptops[0].url }),
    });
    if (!response.ok) throw new Error(`${laptop.name} could not join: ${await response.text()}`);
  }
  await waitForHealthy();
}

async function waitForHealthy() {
  await waitFor(
    async () => (await Promise.all(laptops.map(status))).every((each) => each.state === 'healthy'),
    60_000,
    'every laptop to say "healthy"'
  );
}

async function laptopWithRole(role) {
  const leaderId = (await status(laptops[0])).leader?.hostId;
  for (const laptop of laptops) {
    if (((await status(laptop)).hostId === leaderId) === (role === 'leader')) return laptop;
  }
  throw new Error(`no ${role}`);
}

// Screens.

/** True once the page shows its content from a laptop other than `origin`. */
async function showsPageElsewhere(page, origin) {
  return page
    .evaluate(
      (from) =>
        window.location.origin !== from &&
        document.readyState === 'complete' &&
        Boolean(document.querySelector('#root > *')) &&
        !document.querySelector('.display-loading, .app-state'),
      origin
    )
    .catch(() => false);
}

async function openScreens(browser, laptop) {
  const pages = [];
  for (const screen of SCREENS) {
    const context = await browser.newContext({ userAgent: BROWSER_AGENT, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`${laptop.url}${screen.route}`);
    await page.waitForFunction(
      () => document.querySelector('#root > *') && !document.querySelector('.display-loading')
    );
    // Wait until the screen knows the other laptops, as it would after a minute on the TV.
    const others = laptops.filter((other) => other !== laptop).map((other) => other.url);
    await page.waitForFunction(
      (urls) => urls.every((url) => JSON.parse(localStorage.getItem('apolloon.cluster-members') || '[]').includes(url)),
      others,
      { timeout: 15_000 }
    );
    pages.push({ screen, page, context });
  }
  // Let the live connections settle, so the fault hits screens that are idle.
  await sleep(1_500);
  return pages;
}

/** Milliseconds from now until every page shows itself from another laptop; null for a page that never did. */
async function timeToSwitch(pages, origin, timeoutMs) {
  const start = performance.now();
  const times = pages.map(() => null);
  while (performance.now() - start < timeoutMs && times.some((time) => time === null)) {
    await Promise.all(
      pages.map(async ({ page }, index) => {
        if (times[index] === null && (await showsPageElsewhere(page, origin))) times[index] = performance.now() - start;
      })
    );
    await sleep(25);
  }
  return times;
}

// Faults.

async function crash(laptop) {
  laptop.child.kill('SIGKILL');
  return async () => {
    launch(laptop);
    await waitFor(async () => (await fetch(`${laptop.url}/api/host-info`)).ok, 20_000, `${laptop.name} to restart`);
  };
}

async function freeze(laptop) {
  laptop.child.kill('SIGSTOP');
  return async () => {
    laptop.child.kill('SIGCONT');
  };
}

// The measurement.

const results = [];

/** Milliseconds until a laptop with a working leader says it lost `laptop`: the soonest a screen can know. */
async function timeToGroupVerdict(laptop, hostId, timeoutMs) {
  const start = performance.now();
  const others = laptops.filter((other) => other !== laptop);
  while (performance.now() - start < timeoutMs) {
    const statuses = await Promise.all(others.map((other) => status(other).catch(() => null)));
    const lost = statuses.some(
      (each) => each?.writable && each.members.some((member) => member.hostId === hostId && !member.reachable)
    );
    if (lost) return performance.now() - start;
    await sleep(25);
  }
  return null;
}

async function measureFault(browser, fault, role) {
  const laptop = await laptopWithRole(role);
  const { hostId } = await status(laptop);
  const pages = await openScreens(browser, laptop);
  const heal = await (fault === 'crash' ? crash : freeze)(laptop);
  const [groupMs, times] = await Promise.all([
    timeToGroupVerdict(laptop, hostId, GIVE_UP_MS),
    timeToSwitch(pages, laptop.url, GIVE_UP_MS),
  ]);
  await heal();
  for (const { context } of pages) await context.close();
  await waitForHealthy();
  console.log(`  ${fault.padEnd(6)} ${role.padEnd(8)} ${'the other laptops'.padEnd(26)} ${format(groupMs)}`);
  pages.forEach(({ screen }, index) => {
    results.push({ kind: 'fault', fault, role, screen: screen.name, ms: times[index], groupMs });
    console.log(`  ${fault.padEnd(6)} ${role.padEnd(8)} ${screen.name.padEnd(26)} ${format(times[index])}`);
  });
}

async function measureHiccup(browser, durationMs, role) {
  const laptop = await laptopWithRole(role);
  const pages = await openScreens(browser, laptop);
  laptop.child.kill('SIGSTOP');
  await sleep(durationMs);
  laptop.child.kill('SIGCONT');
  // Whatever a screen decides about this hiccup, it decides within the next 15 s.
  const times = await timeToSwitch(pages, laptop.url, 15_000);
  for (const { context } of pages) await context.close();
  await waitForHealthy();
  pages.forEach(({ screen }, index) => {
    const moved = times[index] !== null;
    results.push({ kind: 'hiccup', durationMs, role, screen: screen.name, moved });
    console.log(
      `  hiccup ${`${durationMs / 1000} s`.padEnd(6)} ${role.padEnd(8)} ${screen.name.padEnd(26)} ${moved ? 'MOVED' : 'stayed'}`
    );
  });
}

function format(ms) {
  return ms === null ? `never (>${GIVE_UP_MS / 1000} s)` : `${(ms / 1000).toFixed(2)} s`;
}

function summary() {
  console.log('\nTime until the screen is back on a working laptop (median / max over rounds and screens):');
  for (const fault of ['crash', 'freeze']) {
    for (const role of ['leader', 'follower']) {
      const times = results
        .filter((result) => result.kind === 'fault' && result.fault === fault && result.role === role)
        .map((result) => result.ms ?? Infinity)
        .sort((a, b) => a - b);
      if (!times.length) continue;
      const median = times[Math.floor((times.length - 1) / 2)];
      const max = times.at(-1);
      console.log(
        `  ${fault.padEnd(6)} ${role.padEnd(8)} ${format(Number.isFinite(median) ? median : null).padEnd(14)} / ${format(Number.isFinite(max) ? max : null)}`
      );
    }
  }
  const hiccups = results.filter((result) => result.kind === 'hiccup');
  if (hiccups.length) {
    console.log('Screens that moved after a short hiccup:');
    for (const durationMs of HICCUPS_MS) {
      const these = hiccups.filter((result) => result.durationMs === durationMs);
      console.log(`  ${durationMs / 1000} s: ${these.filter((result) => result.moved).length} of ${these.length}`);
    }
  }
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let browser;
try {
  if (!fs.existsSync(path.join(repoRoot, 'dist-server/server/index.js'))) throw new Error('Run `npm run build` first.');
  await startGroup();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
  console.log('Laptop dies; time until each screen shows its page from another laptop:');
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const fault of ['crash', 'freeze']) {
      for (const role of ['leader', 'follower']) await measureFault(browser, fault, role);
    }
  }
  console.log('Laptop hiccups and comes back; the screens should stay:');
  for (const durationMs of HICCUPS_MS) {
    for (const role of ['leader', 'follower']) await measureHiccup(browser, durationMs, role);
  }
  summary();
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
} finally {
  await browser?.close();
  for (const laptop of laptops) {
    laptop.child?.kill('SIGCONT');
    laptop.child?.kill('SIGKILL');
  }
  if (!args.keep) fs.rmSync(root, { recursive: true, force: true });
}
