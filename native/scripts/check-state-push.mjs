import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const directory = resolve('.tmp-bench', 'push-recovery-' + new Date().toISOString().replaceAll(':', '-'));
await mkdir(directory, { recursive: true });
const laptops = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function eventually(fn, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Timed out waiting for ' + fn.toString());
}
const status = async (laptop) => (await fetch(laptop.url + '/api/cluster/status')).json();
async function action(laptop, method, input) {
  const response = await fetch(laptop.url + '/api/action/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert(response.ok, await response.clone().text());
  return response.json();
}
async function start(laptop) {
  const child = spawn(resolve('native/target/debug/apolloon-native'), ['--server'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(laptop.port),
      APOLLOON_NATIVE_DATA: join(directory, laptop.name + '.db'),
      CLUSTER_ENABLED: 'true',
      CLUSTER_DISCOVERY: 'false',
      CLUSTER_AUTO_LINK: 'false',
      CLUSTER_SELF_URL: laptop.url,
      CLUSTER_LAPTOP_NAME: laptop.name,
      BACKUP_ENABLED: 'false',
    },
  });
  laptop.child = child;
  child.stdout.on('data', (data) => (laptop.log += data));
  child.stderr.on('data', (data) => (laptop.log += data));
  await eventually(async () => (await fetch(laptop.url + '/api/health')).ok);
}
async function stop(laptop) {
  const exited = once(laptop.child, 'exit');
  laptop.child.kill('SIGTERM');
  await exited;
}
async function laptop(name) {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((done) => listener.close(done));
  const laptop = { name, port, url: 'http://127.0.0.1:' + port, log: '' };
  laptops.push(laptop);
  await start(laptop);
  return laptop;
}
let browser;
try {
  const [a, b, c] = await Promise.all(['Push A', 'Push B', 'Push C'].map(laptop));
  await action(b, 'cluster.joinGroup', { url: a.url });
  await eventually(async () =>
    (await Promise.all([a, b].map(status))).every((s) => s.members?.length === 2 && s.writable && !s.busy)
  );
  await action(c, 'cluster.joinGroup', { url: a.url });
  await eventually(async () =>
    (await Promise.all(laptops.map(status))).every((s) => s.members?.length === 3 && s.writable && !s.busy)
  );
  const roles = await Promise.all(laptops.map(status));
  const leader = laptops[roles.findIndex((s) => s.role === 'leader')];
  assert(leader);
  const follower = laptops.find((l) => l !== leader);
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { get: () => undefined }));
  let fault;
  let dropped = 0;
  let stalled;
  const oldRequests = [];
  await page.route('**/api/state?*', async (route) => {
    if (fault === 'old') {
      oldRequests.push(Date.now());
      const url = new URL(route.request().url());
      for (const key of ['after', 'history', 'since']) url.searchParams.delete(key);
      const response = await route.fetch({ url: url.href });
      const state = await response.json();
      delete state.changeToken;
      return route.fulfill({ response, json: state });
    }
    if (new URL(route.request().url()).searchParams.has('after')) {
      if (fault === 'drop') {
        fault = undefined;
        dropped++;
        return route.abort('failed');
      }
      if (fault === 'stall') {
        fault = undefined;
        stalled = route;
        return;
      }
    }
    return route.continue();
  });
  await page.goto(follower.url + '/queue');
  await page.waitForFunction(() => document.querySelector('[data-rune-a11y]') && !document.querySelector('#status'));
  const visible = (name) =>
    page.waitForFunction((text) => document.querySelector('[data-rune-a11y]')?.textContent.includes(text), name, {
      timeout: 10000,
    });
  async function add(name) {
    await action(leader, 'runners.create', { name, status: 'waiting' });
    await visible(name);
  }
  await add('Initial push');
  fault = 'drop';
  await eventually(() => dropped === 1);
  await add('After dropped connection');
  console.log('PASS: browser resumes state updates after an aborted long-poll connection');
  fault = 'stall';
  await eventually(() => !!stalled);
  const started = Date.now();
  await add('After stalled connection');
  assert(Date.now() - started < 10000);
  await stalled.abort().catch(() => {});
  console.log('PASS: stalled long-poll times out and browser catches up within 10 seconds');
  fault = 'old';
  await eventually(() => oldRequests.length >= 3);
  oldRequests.length = 0;
  await add('Old server compatibility');
  await sleep(3000);
  assert(oldRequests.length >= 3 && oldRequests.length <= 20, String(oldRequests.length));
  console.log(
    `PASS: old server without a token stays live without spinning (${oldRequests.length} state requests in ~3 seconds)`
  );
  fault = undefined;
  await eventually(async () => (await Promise.all(laptops.map(status))).every((s) => s.writable));
  const oldToken = (await (await fetch(follower.url + '/api/state')).json()).changeToken;
  await stop(follower);
  await start(follower);
  const newToken = (await (await fetch(follower.url + '/api/state')).json()).changeToken;
  assert.notEqual(oldToken, newToken);
  await add('After server restart');
  console.log('PASS: screen catches up after its server restarts with a new token epoch');
  await page.goto(follower.url + '/queue');
  await visible('After server restart');
  await eventually(async () => (await status(follower)).writable);
  await stop(follower);
  await page.waitForURL((url) => url.origin !== follower.url, { timeout: 45000, waitUntil: 'commit' });
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/queue');
  await add('After follower failover');
  await page.screenshot({ path: join(directory, 'recovered-queue.png') });
  console.log('PASS: browser fails over from a killed follower, preserves its route, and shows a subsequent write');
  console.log('Evidence: ' + directory);
} finally {
  await browser?.close();
  await Promise.all(
    laptops.map(async (laptop) => {
      if (laptop.child?.exitCode === null && laptop.child?.signalCode === null) await stop(laptop);
      await writeFile(join(directory, laptop.name + '.log'), laptop.log);
    })
  );
}
