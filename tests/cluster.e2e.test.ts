import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../server/router.ts';
import type { AppSnapshot, ClusterStatus, LiveAppSnapshot, RaceHistory } from '../shared/schemas.ts';

/** Laptops in these tests announce themselves on loopback, on a port of their own per test run. */
const discoveryPort = 20_000 + (process.pid % 20_000);

type RunningServer = {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  dataPath: string;
  output: () => string;
  /** Set when the test stops it; any other exit is reported with the server's output. */
  stopping: boolean;
};

test('standalone mode stays writable and does not expose replication', { timeout: 15_000 }, async () => {
  const root = testRoot('standalone');
  const server = await startServer({
    port: await freePort(),
    dataPath: root,
    clusterEnabled: false,
  });
  try {
    const runner = await client(server).runners.create.mutate({ name: 'Solo runner', runnerNumber: 'SOLO-1' });
    assert.equal(runner.runnerNumber, 'SOLO-1');
    const status = await fetchStatus(server);
    assert.equal(status.enabled, false);
    assert.equal(status.role, 'leader');
    assert.equal(status.state, 'solo');
    assert.equal(status.writable, true);

    const health = (await (await fetch(`${server.baseUrl}/api/health`)).json()) as {
      ok: boolean;
      releaseId: string | null;
      database: { ready: boolean; schemaVersion: number };
    };
    assert.equal(health.ok, true);
    assert.equal(health.releaseId, 'e2e-test-release');
    assert.equal(health.database.ready, true);

    const append = await fetch(`${server.baseUrl}/api/cluster/append`, { method: 'POST' });
    assert.equal(append.status, 404);
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a manual backup can be downloaded as a SQLite file', { timeout: 15_000 }, async () => {
  const root = testRoot('backup');
  const server = await startServer({ port: await freePort(), dataPath: root, clusterEnabled: false });
  try {
    await client(server).runners.create.mutate({ name: 'Backup runner', runnerNumber: 'BACKUP-1' });
    const record = await client(server).backups.create.mutate();
    const download = await fetch(`${server.baseUrl}/api/backups/latest`);
    assert.equal(download.ok, true, server.output());
    assert.match(download.headers.get('content-disposition') ?? '', new RegExp(record.fileName));
    const contents = Buffer.from(await download.arrayBuffer());
    assert.equal(contents.subarray(0, 16).toString('binary'), 'SQLite format 3\u0000');
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('three laptops form one group, every laptop writes, and each holds everything', { timeout: 40_000 }, async () => {
  const root = testRoot('group');
  const servers: RunningServer[] = [];
  try {
    const first = await startServer({ port: await freePort(), dataPath: path.join(root, 'first') });
    servers.push(first);
    await client(first).runners.create.mutate({ name: 'Before the group', runnerNumber: 'A-1' });
    const second = await startServer({ port: await freePort(), dataPath: path.join(root, 'second') });
    servers.push(second);
    await client(second).runners.create.mutate({ name: 'Replaced by the join', runnerNumber: 'B-1' });
    // A laptop on its own lists the laptops it could join, without anyone typing an address.
    await waitFor(async () =>
      (await fetchStatus(second)).nearby.some((group) => group.url === first.baseUrl && group.runners === 1)
    );
    const joined = await client(second).cluster.join.mutate({ url: first.baseUrl });
    assert.match(joined.backupFile ?? '', /pre-join/);
    const third = await startServer({ port: await freePort(), dataPath: path.join(root, 'third') });
    servers.push(third);
    await waitFor(async () => (await fetchStatus(third)).nearby.some((group) => group.laptops === 2));
    assert.equal((await fetchStatus(third)).nearby.length, 1, 'the two linked laptops are listed as one group');
    // Joining through a laptop that does not lead works too.
    await client(third).cluster.join.mutate({ url: second.baseUrl });
    await waitFor(async () => (await fetchStatus(first)).state === 'healthy', 10_000);

    for (const [index, server] of servers.entries()) {
      await client(server).runners.create.mutate({ name: `Written on laptop ${index}`, runnerNumber: `W-${index}` });
      // A write returns once a majority stored it, and the laptop it was made on shows it at once.
      assert.ok((await fetchState(server)).runners.some((runner) => runner.name === `Written on laptop ${index}`));
      const holders = await Promise.all(
        servers.map(async (other) =>
          (await fetchState(other)).runners.some((runner) => runner.name === `Written on laptop ${index}`)
        )
      );
      assert.ok(holders.filter(Boolean).length >= 2, `only ${holders.filter(Boolean).length} laptop holds the write`);
    }
    await waitForSameState(first, second);
    await waitForSameState(first, third);
    assert.deepEqual((await fetchState(third)).runners.map((runner) => runner.name).sort(), [
      'Before the group',
      'Written on laptop 0',
      'Written on laptop 1',
      'Written on laptop 2',
    ]);
    const status = await fetchStatus(third);
    assert.equal(status.members.length, 3);
    assert.equal(status.majority, 2);
    assert.deepEqual(status.memberUrls.sort(), [first.baseUrl, second.baseUrl].sort());
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'when the leading laptop dies mid-race, a lap pressed during the takeover counts once, at the press',
  { timeout: 40_000 },
  async () => {
    const root = testRoot('leader-dies');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const leader = await leaderOf(servers);
      assert.ok(leader, 'a leader was chosen');
      const [timing, other] = servers.filter((server) => server !== leader);

      const first = await client(timing).runners.create.mutate({
        name: 'First',
        runnerNumber: 'T-1',
        status: 'waiting',
      });
      await client(other).runners.create.mutate({ name: 'Second', runnerNumber: 'T-2', status: 'waiting' });
      const startedAt = Date.now() - 4_000;
      await client(timing).race.startNext.mutate({ activeRunnerId: null, activeStartedAt: null, pressedAt: startedAt });
      await waitForSameState(leader, timing);

      await killServer(leader);
      const pressedAt = Date.now();
      await client(timing).race.handoff.mutate({
        activeRunnerId: first.id,
        activeStartedAt: startedAt,
        pressedAt,
        measuredDurationMs: pressedAt - startedAt,
      });

      const state = await fetchState(timing);
      assert.equal(state.laps.length, 1, 'the lap is stored once');
      assert.equal(state.laps[0]?.startedAt, startedAt);
      assert.equal(state.laps[0]?.durationMs, pressedAt - startedAt, 'the lap ends at the key press');
      await waitForSameState(timing, other);
      const survivor = await fetchStatus(timing);
      assert.equal(survivor.state, 'degraded');
      assert.equal(survivor.members.filter((member) => !member.reachable).length, 1);

      // The laptop comes back and catches up by itself.
      const restarted = await startServer({ port: leader.port, dataPath: leader.dataPath });
      servers[servers.indexOf(leader)] = restarted;
      await waitForSameState(timing, restarted, 10_000);
      await waitFor(async () => (await fetchStatus(timing)).state === 'healthy', 10_000);
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('a laptop that was off catches up by itself, also across many batches', { timeout: 60_000 }, async () => {
  const root = testRoot('follower-off');
  const servers: RunningServer[] = [];
  try {
    await startGroup(root, servers);
    const leader = (await leaderOf(servers))!;
    const offline = servers.find((server) => server !== leader)!;
    await killServer(offline);
    // Two of three laptops are a majority, so everything keeps working. More than one batch of 500
    // entries piles up; the writes go in chunks, as 520 at once can outlast the commit timeout on a slow disk.
    for (let start = 0; start < 520; start += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, 520 - start) }, (_, offset) => start + offset).map((index) =>
          client(leader).runners.create.mutate({ name: `Offline write ${index}`, runnerNumber: `OFF-${index}` })
        )
      );
    }
    const restarted = await startServer({ port: offline.port, dataPath: offline.dataPath });
    servers[servers.indexOf(offline)] = restarted;
    await waitForSameState(leader, restarted, 20_000);
    assert.equal((await fetchStatus(restarted)).role, 'follower');
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'a laptop cut off from the others saves nothing, and takes the group data when the cable is back',
  { timeout: 40_000 },
  async () => {
    const root = testRoot('cut-off');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const cutOff = (await leaderOf(servers))!;
      const others = servers.filter((server) => server !== cutOff);
      await client(cutOff).runners.create.mutate({ name: 'Shared', runnerNumber: 'S-1' });

      await isolate(cutOff, true);
      await assert.rejects(
        client(cutOff).runners.create.mutate({ name: 'Never confirmed', runnerNumber: 'S-2' }),
        /Niet bevestigd|Niet opgeslagen/
      );
      await waitFor(async () => (await leaderOf(others)) !== null, 10_000);
      await client(others[0]).runners.create.mutate({ name: 'Written by the majority', runnerNumber: 'S-3' });
      assert.equal((await fetchStatus(cutOff)).writable, false);

      await isolate(cutOff, false);
      await waitForSameState(others[0], cutOff, 10_000);
      const names = (await fetchState(cutOff)).runners.map((runner) => runner.name).sort();
      assert.deepEqual(names, ['Shared', 'Written by the majority']);
      const backups = fs.readdirSync(path.join(cutOff.dataPath, 'backups'));
      assert.ok(
        backups.some((file) => file.includes('pre-resync')),
        backups.join(', ')
      );
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'with two laptops gone for good, the last one goes on alone and the others rejoin with its data',
  { timeout: 60_000 },
  async () => {
    const root = testRoot('alone');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const [last, ...gone] = servers;
      await client(last).runners.create.mutate({ name: 'Before', runnerNumber: 'L-1' });
      await waitForSameState(last, gone[0]);
      await waitForSameState(last, gone[1]);
      await Promise.all(gone.map(killServer));

      await waitFor(async () => (await fetchStatus(last)).state === 'no-majority', 15_000);
      await assert.rejects(
        client(last).runners.create.mutate({ name: 'Nobody to confirm', runnerNumber: 'L-2' }),
        /Niet opgeslagen|Niet bevestigd/
      );
      await client(last).cluster.continueAlone.mutate();
      await client(last).runners.create.mutate({ name: 'Alone', runnerNumber: 'L-3' });

      for (const [index, server] of gone.entries()) {
        const restarted = await startServer({ port: server.port, dataPath: server.dataPath });
        servers[index + 1] = restarted;
      }
      await waitForSameState(last, servers[1], 15_000);
      await waitForSameState(last, servers[2], 15_000);
      assert.deepEqual((await fetchState(servers[2])).runners.map((runner) => runner.name).sort(), ['Alone', 'Before']);
      await waitFor(async () => (await fetchStatus(last)).state === 'healthy', 15_000);
      assert.equal((await fetchStatus(last)).members.length, 3);
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('the laptops find each other again when every address changes', { timeout: 60_000 }, async () => {
  const root = testRoot('new-addresses');
  const servers: RunningServer[] = [];
  try {
    await startGroup(root, servers);
    await client(servers[0]).runners.create.mutate({ name: 'Before the new router', runnerNumber: 'N-1' });
    await waitForSameState(servers[0], servers[1]);
    await waitForSameState(servers[0], servers[2]);

    // Like a router swap: every laptop comes back at an address the others never saw.
    await Promise.all(servers.map(stopServer));
    for (const [index, server] of servers.entries()) {
      servers[index] = await startServer({ port: await freePort(), dataPath: server.dataPath });
    }
    await waitFor(async () => (await fetchStatus(servers[0])).state === 'healthy', 20_000);
    await client(servers[2]).runners.create.mutate({ name: 'After the new router', runnerNumber: 'N-2' });
    await waitForSameState(servers[2], servers[0]);
    await waitForSameState(servers[2], servers[1]);
    const urls = (await fetchStatus(servers[1])).members.map((member) => member.url).sort();
    assert.deepEqual(urls, servers.map((server) => server.baseUrl).sort());
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a write repeated after a takeover is applied once', { timeout: 30_000 }, async () => {
  const root = testRoot('repeat');
  const servers: RunningServer[] = [];
  try {
    await startGroup(root, servers);
    const leader = (await leaderOf(servers))!;
    const send = async () => {
      const response = await fetch(`${leader.baseUrl}/trpc/runners.create`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-apolloon-forwarded': '1',
          'x-apolloon-request-id': 'repeated-request',
        },
        body: JSON.stringify({ name: 'Once', runnerNumber: 'ONCE-1' }),
      });
      assert.equal(response.ok, true, await response.clone().text());
      return ((await response.json()) as { result: { data: { id: string } } }).result.data.id;
    };
    const [firstId, repeatId] = [await send(), await send()];
    assert.equal(repeatId, firstId);
    assert.equal((await fetchState(leader)).runners.filter((runner) => runner.name === 'Once').length, 1);
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('laptops with different app versions refuse to couple', { timeout: 20_000 }, async () => {
  const root = testRoot('versions');
  const servers: RunningServer[] = [];
  try {
    const first = await startServer({ port: await freePort(), dataPath: path.join(root, 'a'), appVersion: '1.0.0' });
    const other = await startServer({ port: await freePort(), dataPath: path.join(root, 'b'), appVersion: '2.0.0' });
    servers.push(first, other);
    await assert.rejects(client(other).cluster.join.mutate({ url: first.baseUrl }), /Upgrade vereist/);
    const append = await fetch(`${first.baseUrl}/api/cluster/append`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-apolloon-app-version': '2.0.0',
        'x-apolloon-schema-version': '13',
      },
      body: '{}',
    });
    assert.equal(append.status, 426);
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function client(server: RunningServer) {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${server.baseUrl}/trpc` })] });
}

/** Three laptops in one group, like at the event; pushed onto `servers` as they start so they are always stopped. */
async function startGroup(root: string, servers: RunningServer[]): Promise<void> {
  for (const name of ['a', 'b', 'c']) {
    servers.push(await startServer({ port: await freePort(), dataPath: path.join(root, name) }));
  }
  for (const server of servers.slice(1)) await client(server).cluster.join.mutate({ url: servers[0].baseUrl });
  await waitFor(async () => (await fetchStatus(servers[0])).state === 'healthy', 10_000);
}

async function leaderOf(servers: RunningServer[]): Promise<RunningServer | null> {
  const statuses = await Promise.all(servers.map((server) => fetchStatus(server).catch(() => null)));
  const index = statuses.findIndex((status) => status?.role === 'leader' && status.writable);
  return index >= 0 ? servers[index] : null;
}

/** Simulates a pulled network cable. */
async function isolate(server: RunningServer, isolated: boolean): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/cluster/test/isolate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolated }),
  });
  assert.equal(response.ok, true);
}

async function startServer(options: {
  port: number;
  dataPath: string;
  clusterEnabled?: boolean;
  appVersion?: string;
}): Promise<RunningServer> {
  fs.mkdirSync(options.dataPath, { recursive: true });
  const chunks: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(options.port),
      PUBLIC_APP_PORT: String(options.port),
      DATA_PATH: options.dataPath,
      CLUSTER_ENABLED: options.clusterEnabled === false ? 'false' : 'true',
      CLUSTER_SELF_URL: `http://127.0.0.1:${options.port}`,
      CLUSTER_HEARTBEAT_MS: '50',
      CLUSTER_ELECTION_TIMEOUT_MS: '400',
      CLUSTER_COMMIT_TIMEOUT_MS: '3000',
      CLUSTER_WRITE_DEADLINE_MS: '6000',
      CLUSTER_REQUEST_TIMEOUT_MS: '300',
      CLUSTER_TEST_FAULTS: 'true',
      CLUSTER_DISCOVERY_ADDRESS: '127.255.255.255',
      CLUSTER_DISCOVERY_PORT: String(discoveryPort),
      CLUSTER_DISCOVERY_INTERVAL_MS: '200',
      BACKUP_ENABLED: 'false',
      APOLLOON_RELEASE_ID: 'e2e-test-release',
      APOLLOON_APP_VERSION: options.appVersion || '1.0.0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => chunks.push(chunk.toString()));
  child.stderr?.on('data', (chunk) => chunks.push(chunk.toString()));
  const server: RunningServer = {
    process: child,
    port: options.port,
    baseUrl: `http://127.0.0.1:${options.port}`,
    dataPath: options.dataPath,
    output: () => chunks.join(''),
    stopping: false,
  };
  child.once('exit', (code, signal) => {
    chunks.push(`\n[exited: ${code ?? signal}]\n`);
    if (!server.stopping) {
      process.stderr.write(`Server ${server.baseUrl} stopped unexpectedly (${code ?? signal}):\n${server.output()}\n`);
    }
  });
  await waitFor(async () => {
    if (hasExited(server)) throw new Error(`server exited\n${server.output()}`);
    return (await fetch(`${server.baseUrl}/api/host-info`).catch(() => null))?.ok === true;
  });
  return server;
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || hasExited(server)) return;
  server.stopping = true;
  const exited = waitForExit(server);
  server.process.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (!hasExited(server)) server.process.kill('SIGKILL');
  await exited;
}

/** A laptop that suddenly loses power. */
async function killServer(server: RunningServer): Promise<void> {
  if (hasExited(server)) return;
  server.stopping = true;
  const exited = waitForExit(server);
  server.process.kill('SIGKILL');
  await exited;
}

/** A process killed by a signal keeps `exitCode` null, so both are checked. */
function hasExited(server: RunningServer): boolean {
  return server.process.exitCode !== null || server.process.signalCode !== null;
}

function waitForExit(server: RunningServer): Promise<void> {
  if (hasExited(server)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${server.baseUrl} did not stop\n${server.output()}`)), 10_000);
    server.process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function fetchState(server: RunningServer): Promise<AppSnapshot> {
  const [stateResponse, historyResponse] = await Promise.all([
    fetch(`${server.baseUrl}/api/state`),
    fetch(`${server.baseUrl}/api/history`),
  ]);
  assert.equal(stateResponse.ok, true);
  assert.equal(historyResponse.ok, true);
  const [state, history] = await Promise.all([
    stateResponse.json() as Promise<LiveAppSnapshot>,
    historyResponse.json() as Promise<RaceHistory>,
  ]);
  return { ...state, laps: history.laps, events: history.events };
}

async function fetchStatus(server: RunningServer): Promise<ClusterStatus> {
  const response = await fetch(`${server.baseUrl}/api/cluster/status`);
  assert.equal(response.ok, true);
  return response.json() as Promise<ClusterStatus>;
}

function comparableState(state: AppSnapshot): unknown {
  const { revision: _revision, host: _host, ...data } = state;
  return data;
}

async function waitForSameState(source: RunningServer, copy: RunningServer, timeoutMs = 8_000): Promise<void> {
  await waitFor(async () => {
    const [expected, actual] = await Promise.all([fetchState(source), fetchState(copy)]);
    return JSON.stringify(comparableState(expected)) === JSON.stringify(comparableState(actual));
  }, timeoutMs);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Condition timed out');
}

function testRoot(name: string): string {
  const root = path.resolve(`.tmp-test-cluster-${name}-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  return root;
}

function withServerOutput(error: unknown, ...servers: Array<RunningServer | null>): Error {
  const output = servers
    .filter((server): server is RunningServer => Boolean(server))
    .map((server) => `${server.baseUrl}\n${server.output()}`)
    .join('\n');
  return new Error(`${error instanceof Error ? error.stack || error.message : String(error)}\n${output}`);
}
