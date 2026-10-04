// Starts the packaged app as the leading laptop of a group of two, opens Beheer › Systeem in its
// own window, and checks that the network panel fills in while the server keeps answering and
// the other laptop keeps hearing its heartbeats. On Windows the panel reads the profile through
// PowerShell, the path that once held the server still for seconds.
// Usage, after an electron:build: node scripts/package-system-ui.mjs [extra Electron arguments]
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { packagedApp, version } from './packaged-app.mjs';

/** Longest the server may leave /api/health unanswered while the profile is read. */
const MAX_SILENCE_MS = 500;
/** The other laptop holds an election after this much silence: stricter than the 1.5 s at the event. */
const FOLLOWER_ELECTION_TIMEOUT_MS = 750;
const windows = process.platform === 'win32';

const temporary = mkdtempSync(path.join(tmpdir(), 'apolloon-package-system-'));
const processes = [];
let browser = null;
try {
  const app = packagedApp(temporary);
  const [leaderPort, followerPort, debugPort] = [await freePort(), await freePort(), await freePort()];
  const leaderUrl = `http://127.0.0.1:${leaderPort}`;
  const followerUrl = `http://127.0.0.1:${followerPort}`;

  // The desktop app reads its settings from .env in its data folder, like on a laptop.
  const leaderData = path.join(temporary, 'leader');
  mkdirSync(leaderData);
  writeFileSync(
    path.join(leaderData, '.env'),
    `PORT=${leaderPort}\nCLUSTER_SELF_URL=${leaderUrl}\nCLUSTER_DISCOVERY=false\nBACKUP_ENABLED=false\n`
  );
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...desktopEnv } = process.env;
  processes.push(
    spawn(
      app.executable,
      [
        '--no-sandbox',
        `--user-data-dir=${leaderData}`,
        `--remote-debugging-port=${debugPort}`,
        ...process.argv.slice(2),
      ],
      { env: desktopEnv, stdio: 'inherit', detached: !windows }
    )
  );

  // The other laptop needs no window: the packaged server itself, run the way the desktop app runs it.
  const followerData = path.join(temporary, 'follower');
  mkdirSync(followerData);
  processes.push(
    spawn(app.binary, [path.join(app.resources, 'app.asar', 'dist-server', 'server', 'index.js')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        DATA_PATH: followerData,
        PORT: String(followerPort),
        CLUSTER_ENABLED: 'true',
        CLUSTER_SELF_URL: followerUrl,
        CLUSTER_DISCOVERY: 'false',
        CLUSTER_ELECTION_TIMEOUT_MS: String(FOLLOWER_ELECTION_TIMEOUT_MS),
        BACKUP_ENABLED: 'false',
        APOLLOON_APP_VERSION: version,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: !windows,
    })
  );

  await waitUntil(async () => (await getJson(`${leaderUrl}/api/health`)).ok, 60_000, 'the packaged app starts');
  await waitUntil(async () => (await getJson(`${followerUrl}/api/health`)).ok, 30_000, 'the other laptop starts');
  await join(followerUrl, leaderUrl);
  const leader = await getJson(`${leaderUrl}/api/cluster/status`);
  await waitUntil(
    async () => {
      const [ownStatus, otherStatus] = await Promise.all([
        getJson(`${leaderUrl}/api/cluster/status`),
        getJson(`${followerUrl}/api/cluster/status`),
      ]);
      return ownStatus.role === 'leader' && ownStatus.state === 'healthy' && hearsLeader(otherStatus, leader.hostId);
    },
    15_000,
    'the packaged app leads both laptops'
  );
  console.log('PASS the packaged app leads a group of two laptops');

  browser = await connectToWindow(debugPort);
  const page = await waitForWindowPage(browser, leaderUrl);
  const reads = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/net/profile') reads.push({ request, startedAt: performance.now() });
  });
  const readDone = (request) => {
    const read = reads.find((candidate) => candidate.request === request);
    if (read) read.endedAt = performance.now();
  };
  page.on('requestfinished', readDone);
  page.on('requestfailed', readDone);

  const watch = watchServers(leaderUrl, followerUrl, leader.hostId);
  const profileResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/net/profile');
  // Beheer keeps every section mounted, so the profile is read as soon as Beheer opens.
  await page.goto(`${leaderUrl}/admin`);
  await page.locator('.management-navigation').getByText('Systeem & herstel').click();
  const panel = page.locator('section.panel', { has: page.getByRole('heading', { name: 'Vast netwerkadres' }) });
  await panel.waitFor();
  await panel.getByText('Bezig met opzoeken…').waitFor({ state: 'detached', timeout: 20_000 });
  const loadError = panel.getByRole('alert').filter({ hasText: 'Netwerkstatus kon niet geladen worden' });
  assert.equal(await loadError.count(), 0, `The network panel failed: ${await loadError.allInnerTexts()}`);
  const { profile } = await (await profileResponse).json();
  if (profile.primary) await panel.getByText(profile.primary.address, { exact: false }).first().waitFor();
  await waitUntil(async () => reads.length > 0 && reads.every((read) => read.endedAt), 20_000, 'the profile read ends');
  // Keep watching a little longer: a stalled server answers the queued requests only afterwards.
  await new Promise((resolve) => setTimeout(resolve, FOLLOWER_ELECTION_TIMEOUT_MS * 2));
  const watched = await watch.stop();
  console.log(`PASS Beheer › Systeem fills in the network panel (${describeProfile(profile)})`);

  if (windows) {
    assert.equal(profile.windows, true);
    assert.equal(profile.elevateMethod, 'uac');
    assert.ok(profile.primary, 'Windows reported no network address');
    assert.equal(
      typeof profile.primary.dhcp,
      'boolean',
      'Windows reported no DHCP state: the PowerShell read failed or returned nothing'
    );
    assert.ok(Number.isInteger(profile.primary.prefixLength));
    assert.equal(await panel.getByText('adresbron onbekend').count(), 0, 'The panel shows no DHCP state');
    const action = profile.primary.dhcp ? 'Maak dit adres vast' : 'Dit adres staat vast';
    await panel.getByText(action).first().waitFor();
    console.log('PASS PowerShell reads the DHCP state and prefix length of the adapter');
  } else {
    console.log(`SKIP the PowerShell reads only run on Windows (this is ${process.platform})`);
  }

  for (const read of reads) {
    const window = { from: read.startedAt, to: read.endedAt };
    const silence = longestSilence(watched.health, window);
    assert.ok(
      silence < MAX_SILENCE_MS,
      `The server left /api/health unanswered for ${Math.round(silence)} ms while the profile was read`
    );
    console.log(
      `PASS the server keeps answering while the profile is read (${Math.round(window.to - window.from)} ms read, ` +
        `longest wait for /api/health ${Math.round(silence)} ms)`
    );
  }
  const failed = watched.health.filter((answer) => !answer.ok);
  assert.deepEqual(failed, [], '/api/health failed while Beheer › Systeem opened');
  const missed = watched.follower.filter((sample) => !sample.hearsLeader);
  assert.deepEqual(missed, [], 'The other laptop lost the leader while Beheer › Systeem opened');
  const terms = new Set(watched.follower.map((sample) => sample.term));
  assert.equal(terms.size, 1, `The laptops held an election (terms ${[...terms].join(', ')})`);
  console.log(`PASS the other laptop kept hearing the heartbeats (${watched.follower.length} checks, no election)`);
} finally {
  await browser?.close().catch(() => undefined);
  for (const child of processes) stop(child);
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

/**
 * Polls /api/health on the leader back to back and the other laptop's group status every
 * 50 ms, until stopped.
 */
function watchServers(leaderUrl, followerUrl, leaderHostId) {
  let stopped = false;
  const health = [];
  const follower = [];
  const pollHealth = async () => {
    while (!stopped) {
      const sentAt = performance.now();
      const body = await getJson(`${leaderUrl}/api/health`).catch((error) => ({ ok: false, error: String(error) }));
      health.push({ sentAt, answeredAt: performance.now(), ok: body.ok === true, error: body.error });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const pollFollower = async () => {
    while (!stopped) {
      const status = await getJson(`${followerUrl}/api/cluster/status`).catch(() => null);
      follower.push({ at: performance.now(), hearsLeader: hearsLeader(status, leaderHostId), term: status?.term });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const running = Promise.all([pollHealth(), pollFollower()]);
  return {
    async stop() {
      stopped = true;
      await running;
      return { health, follower };
    },
  };
}

/** The longest stretch within `window` without an answer, up to the first answer after it. */
function longestSilence(answers, window) {
  let last = window.from;
  let longest = 0;
  for (const answer of [...answers].sort((a, b) => a.answeredAt - b.answeredAt)) {
    if (answer.answeredAt <= window.from) continue;
    longest = Math.max(longest, answer.answeredAt - last);
    last = answer.answeredAt;
    if (answer.answeredAt >= window.to) return longest;
  }
  assert.fail('/api/health was not watched until after the profile read');
}

function hearsLeader(status, leaderHostId) {
  return Boolean(status?.writable && status.leader?.hostId === leaderHostId);
}

function describeProfile(profile) {
  if (!profile.primary) return `${profile.platform}, no network address`;
  const { name, address, prefixLength, dhcp } = profile.primary;
  return `${profile.platform}, ${name} ${address}/${prefixLength}, ${dhcp === null ? 'DHCP unknown' : dhcp ? 'DHCP' : 'static'}`;
}

/** Links the other laptop to the leader's group; right after starting it may answer "try again". */
async function join(url, leaderUrl) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const response = await fetch(`${url}/trpc/cluster.join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: leaderUrl }),
    });
    if (response.ok) return;
    const text = await response.text();
    if (!/opnieuw/.test(text) || Date.now() > deadline) assert.fail(`Joining failed: ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The DevTools endpoint opens before the window; keep trying until it answers. */
async function connectToWindow(port) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function waitForWindowPage(connected, url) {
  let page = null;
  await waitUntil(
    async () => {
      page = connected
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith(url));
      return Boolean(page);
    },
    30_000,
    'the app window opens'
  );
  await page.locator('#root > *').first().waitFor();
  return page;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return response.json();
}

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Timed out waiting until ${description}`);
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (windows) execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

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
