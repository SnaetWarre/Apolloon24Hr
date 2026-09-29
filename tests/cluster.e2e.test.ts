import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../server/router.ts';
import type { AppSnapshot, ClusterStatus, LiveAppSnapshot, RaceHistory } from '../shared/schemas.ts';

type RunningServer = {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  dataPath: string;
  output: () => string;
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
    assert.equal(status.role, 'primary');
    assert.equal(status.writable, true);

    const health = (await (await fetch(`${server.baseUrl}/api/health`)).json()) as {
      ok: boolean;
      releaseId: string | null;
      database: { ready: boolean; schemaVersion: number };
    };
    assert.equal(health.ok, true);
    assert.equal(health.releaseId, 'e2e-test-release');
    assert.equal(health.database.ready, true);

    const pull = await fetch(`${server.baseUrl}/api/cluster/pull`, { method: 'POST' });
    assert.equal(pull.status, 404);
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

test(
  'a standby joins, follows every write read-only, and catches up after a restart',
  { timeout: 40_000 },
  async () => {
    const root = testRoot('standby');
    const servers: RunningServer[] = [];
    try {
      const primary = await startServer({ port: await freePort(), dataPath: path.join(root, 'primary') });
      servers.push(primary);
      let standby = await startServer({ port: await freePort(), dataPath: path.join(root, 'standby') });
      servers.push(standby);

      await client(primary).runners.create.mutate({ name: 'Before join', runnerNumber: 'A-1' });
      await client(standby).runners.create.mutate({ name: 'Replaced by the join', runnerNumber: 'B-1' });
      const joined = await client(standby).cluster.join.mutate({ primaryUrl: primary.baseUrl });
      assert.match(joined.backupFile, /pre-join/);
      await waitForSameState(primary, standby);
      assert.deepEqual(
        (await fetchState(standby)).runners.map((runner) => runner.name),
        ['Before join']
      );

      await client(primary).runners.create.mutate({ name: 'After join', runnerNumber: 'A-2' });
      await waitForSameState(primary, standby);
      await assert.rejects(
        client(standby).runners.create.mutate({ name: 'Written on a standby', runnerNumber: 'B-2' }),
        /standby en alleen-lezen/
      );
      await waitFor(async () =>
        (await fetchStatus(primary)).standbys.some((entry) => entry.reachable && entry.caughtUp)
      );
      assert.equal((await fetchStatus(standby)).primary?.url, primary.baseUrl);

      // More than one pull batch arrives while the standby is offline.
      await stopServer(standby);
      await Promise.all(
        Array.from({ length: 520 }, (_, index) =>
          client(primary).runners.create.mutate({ name: `Offline write ${index}`, runnerNumber: `OFF-${index}` })
        )
      );
      standby = await startServer({ port: standby.port, dataPath: standby.dataPath });
      servers[1] = standby;
      await waitForSameState(primary, standby, 15_000);
      assert.equal((await fetchStatus(standby)).role, 'standby');
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'a planned promotion hands over without losing writes and the old primary follows',
  { timeout: 30_000 },
  async () => {
    const root = testRoot('planned');
    const servers: RunningServer[] = [];
    try {
      const first = await startServer({ port: await freePort(), dataPath: path.join(root, 'first') });
      const second = await startServer({ port: await freePort(), dataPath: path.join(root, 'second') });
      servers.push(first, second);
      await client(second).cluster.join.mutate({ primaryUrl: first.baseUrl });
      const runner = await client(first).runners.create.mutate({
        name: 'Handed over',
        runnerNumber: 'H-1',
        status: 'waiting',
      });
      await client(first).race.startNext.mutate({ activeRunnerId: null, activeStartedAt: null });

      assert.deepEqual(await client(second).cluster.promote.mutate({ emergency: false }), { result: 'planned' });
      const [firstStatus, secondStatus] = await Promise.all([fetchStatus(first), fetchStatus(second)]);
      assert.equal(secondStatus.role, 'primary');
      assert.equal(firstStatus.role, 'standby');
      assert.equal(firstStatus.primary?.url, second.baseUrl);
      assert.equal(secondStatus.epoch, 1);
      assert.equal((await fetchState(second)).race.activeRunnerId, runner.id, 'the running lap moved along');

      await client(second).runners.create.mutate({ name: 'After handover', runnerNumber: 'H-2' });
      await waitForSameState(second, first);
      await assert.rejects(
        client(first).runners.create.mutate({ name: 'Old primary', runnerNumber: 'H-3' }),
        /standby/
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
  'after an emergency takeover a returning old primary re-syncs and keeps its own writes in a backup',
  { timeout: 40_000 },
  async () => {
    const root = testRoot('emergency');
    const servers: RunningServer[] = [];
    try {
      let old = await startServer({ port: await freePort(), dataPath: path.join(root, 'old'), probeIntervalMs: 1_500 });
      const survivor = await startServer({ port: await freePort(), dataPath: path.join(root, 'survivor') });
      servers.push(old, survivor);
      await client(survivor).cluster.join.mutate({ primaryUrl: old.baseUrl });
      await client(old).runners.create.mutate({ name: 'Shared', runnerNumber: 'S-1' });
      await waitForSameState(old, survivor);

      await stopServer(old);
      assert.deepEqual(await client(survivor).cluster.promote.mutate({ emergency: false }), {
        result: 'primary-unreachable',
      });
      assert.deepEqual(await client(survivor).cluster.promote.mutate({ emergency: true }), { result: 'emergency' });
      await client(survivor).runners.create.mutate({ name: 'Written by the survivor', runnerNumber: 'S-2' });

      // The old primary comes back still believing it is primary and records a write before it notices.
      old = await startServer({ port: old.port, dataPath: old.dataPath, probeIntervalMs: 1_500 });
      servers[0] = old;
      await client(old).runners.create.mutate({ name: 'Split-brain write', runnerNumber: 'S-3' });

      await waitFor(async () => (await fetchStatus(old)).role === 'standby', 10_000);
      await waitForSameState(survivor, old, 10_000);
      assert.equal(
        (await fetchState(old)).runners.some((runner) => runner.name === 'Split-brain write'),
        false
      );
      const backups = fs.readdirSync(path.join(old.dataPath, 'backups'));
      assert.ok(
        backups.some((file) => file.includes('pre-standby-resync')),
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

test('laptops with different app versions refuse to couple', { timeout: 20_000 }, async () => {
  const root = testRoot('versions');
  const servers: RunningServer[] = [];
  try {
    const primary = await startServer({ port: await freePort(), dataPath: path.join(root, 'a'), appVersion: '1.0.0' });
    const other = await startServer({ port: await freePort(), dataPath: path.join(root, 'b'), appVersion: '2.0.0' });
    servers.push(primary, other);
    await assert.rejects(client(other).cluster.join.mutate({ primaryUrl: primary.baseUrl }), /Upgrade vereist/);
    const pull = await fetch(`${primary.baseUrl}/api/cluster/pull`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-apolloon-app-version': '2.0.0',
        'x-apolloon-schema-version': '13',
      },
      body: '{}',
    });
    assert.equal(pull.status, 426);
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

async function startServer(options: {
  port: number;
  dataPath: string;
  clusterEnabled?: boolean;
  appVersion?: string;
  probeIntervalMs?: number;
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
      CLUSTER_PULL_INTERVAL_MS: '50',
      CLUSTER_PROBE_INTERVAL_MS: String(options.probeIntervalMs ?? 300),
      CLUSTER_REQUEST_TIMEOUT_MS: '500',
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
  };
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}\n${server.output()}`);
    return (await fetch(`${server.baseUrl}/api/host-info`).catch(() => null))?.ok === true;
  });
  return server;
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.process.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.process.once('exit', () => resolve()));
  server.process.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (server.process.exitCode === null) {
    server.process.kill('SIGKILL');
    await exited;
  }
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
