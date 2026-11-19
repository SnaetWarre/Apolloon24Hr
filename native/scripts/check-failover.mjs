import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';

const directory = await mkdtemp(join(tmpdir(), 'apolloon-browser-failover-'));
const laptops = [];
const browserStatus = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function eventually(fn) {
  const expires = Date.now() + 20000;
  while (Date.now() < expires) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Timed out');
}
const status = async (l) => (await fetch(l.url + '/api/cluster/status')).json();
async function action(l, method, body) {
  const response = await fetch(l.url + '/api/action/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(response.ok, await response.clone().text());
  return response.json();
}
async function laptop(name) {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  const url = 'http://127.0.0.1:' + port;
  const child = spawn(resolve('native/target/debug/apolloon-native'), ['--server'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(port),
      APOLLOON_NATIVE_DATA: join(directory, name + '.db'),
      CLUSTER_ENABLED: 'true',
      CLUSTER_DISCOVERY: 'false',
      CLUSTER_AUTO_LINK: 'false',
      CLUSTER_SELF_URL: url,
      CLUSTER_LAPTOP_NAME: name,
      BACKUP_ENABLED: 'false',
    },
  });
  const l = { name, url, child };
  laptops.push(l);
  await eventually(async () => (await fetch(url + '/api/health')).ok);
  return l;
}
let browser;
try {
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(laptop));
  await action(b, 'cluster.joinGroup', { url: a.url });
  await eventually(async () => {
    const group = await Promise.all([a, b].map(status));
    return group.every((member) => member.members?.length === 2 && member.writable && !member.busy);
  });
  await action(c, 'cluster.joinGroup', { url: a.url });
  await eventually(async () => {
    const group = await Promise.all(laptops.map(status));
    return group.every(
      (member) =>
        member.members?.length === 3 && member.clusterId === group[0].clusterId && member.writable && !member.busy
    );
  });
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  function recordStatus(message) {
    browserStatus.push(message);
    if (browserStatus.length > 24) browserStatus.shift();
  }
  page.on('pageerror', (error) => recordStatus(error.message));
  page.on('requestfailed', (request) => {
    if (request.url().endsWith('/api/cluster/status')) {
      recordStatus(`${request.url()} ${request.failure()?.errorText}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().endsWith('/api/cluster/status')) {
      recordStatus(`${response.url()} HTTP ${response.status()}`);
    }
  });
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { get: () => undefined }));
  const remembered = page.waitForResponse((r) => r.url() === a.url + '/api/cluster/status' && r.ok(), {
    timeout: 60000,
  });
  const section = '/display/outside?thema=donker&zoom=125';
  const { promise: allowWasm, resolve: releaseWasm } = Promise.withResolvers();
  await page.route(a.url + '/app_bg.wasm', async (route) => {
    await allowWasm;
    await route.continue();
  });
  try {
    await page.goto(a.url + section, { waitUntil: 'commit' });
    assert.equal((await (await remembered).json()).memberUrls.length, 2);
    await page.waitForFunction(() => performance.getEntriesByName('apolloon.cluster.ready').length > 0, null, {
      timeout: 30000,
    });
  } finally {
    releaseWasm();
  }
  await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('#status'));
  await page.keyboard.press('F11');
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.keyboard.press('F11');
  await page.waitForFunction(() => !document.fullscreenElement);
  console.log('PASS: F11 enters and leaves browser fullscreen on the public display');
  a.child.kill('SIGTERM');
  await once(a.child, 'exit');
  await page.waitForURL((url) => url.origin !== a.url, { timeout: 45000, waitUntil: 'commit' });
  const next = new URL(page.url());
  assert([b.url, c.url].includes(next.origin));
  assert.equal(next.pathname + next.search, section);
  await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('#status'), null, {
    timeout: 45000,
  });
  const evidence = resolve('.tmp-native-evidence/failover');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, 'public-failover.png') });
  console.log('PASS: live public browser moved to a surviving Rust laptop and kept display, theme and zoom');
} catch (error) {
  const surviving = laptops.filter((laptop) => laptop.child.exitCode === null && laptop.child.signalCode === null);
  console.error('Recent browser cluster requests:', browserStatus);
  console.error('Surviving cluster state:', await Promise.allSettled(surviving.map(status)));
  throw error;
} finally {
  await browser?.close();
  for (const laptop of laptops) {
    if (laptop.child.exitCode === null && laptop.child.signalCode === null) {
      laptop.child.kill();
      await once(laptop.child, 'exit');
    }
  }
  await rm(directory, { recursive: true, force: true });
}
