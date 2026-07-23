import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../server/router.ts';
import type { AppSnapshot, PublicRecordMode } from '../shared/schemas.ts';

type RunningServer = {
  process: ChildProcess;
  baseUrl: string;
  output: () => string;
};

test('standalone servers reject cluster control and replication requests', { timeout: 10_000 }, async () => {
  const testRoot = path.resolve(`.tmp-test-cluster-disabled-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  const port = await freePort();
  let server: RunningServer | null = null;

  try {
    server = await startApolloonServer({
      port,
      dataPath: testRoot,
      peers: [],
      clusterEnabled: false,
    });
    const before = await fetchState(port);
    const heartbeatResponse = await fetch(`http://127.0.0.1:${port}/api/cluster/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        term: 99,
        leaderId: 'untrusted-host',
        leaderUrl: 'http://127.0.0.1:1',
        lastSeq: 99,
      }),
    });
    const operationsResponse = await fetch(`http://127.0.0.1:${port}/api/cluster/operations`);

    assert.equal(heartbeatResponse.status, 404);
    assert.equal(operationsResponse.status, 404);
    assert.equal((await fetchClusterStatus(port)).role, 'standalone');
    const after = await fetchState(port);
    assert.deepEqual(
      { ...after, serverNowMs: 0 },
      { ...before, serverNowMs: 0 }
    );
  } catch (error) {
    throw withServerOutput(error, server);
  } finally {
    await stopServer(server);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('a late standby receives one checkpoint, then proxies writes with a valid replicated response', { timeout: 20_000 }, async () => {
  const testRoot = path.resolve(`.tmp-test-cluster-proxy-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  const leaderPort = await freePort();
  const followerPort = await freePort();
  let leader: RunningServer | null = null;
  let follower: RunningServer | null = null;

  try {
    leader = await startApolloonServer({
      port: leaderPort,
      dataPath: path.join(testRoot, 'leader'),
      peers: [followerPort],
      bootstrapLeader: true,
    });
    const leaderClient = createClient(leaderPort);
    const beforeStandby = await leaderClient.runners.create.mutate({
      name: 'Created before standby',
      runnerNumber: 'NET-EARLY',
    });
    assert.equal((await fetchClusterStatus(leaderPort)).lastAppliedSeq, 0);

    follower = await startApolloonServer({
      port: followerPort,
      dataPath: path.join(testRoot, 'follower'),
      peers: [leaderPort],
    });

    await waitFor(async () => {
      const [leaderStatus, followerStatus] = await Promise.all([
        fetchClusterStatus(leaderPort),
        fetchClusterStatus(followerPort),
      ]);
      return leaderStatus.role === 'leader' && followerStatus.role === 'follower';
    });
    await waitFor(async () => {
      const followerState = await fetchState(followerPort);
      return followerState.runners.some((item) => item.id === beforeStandby.id);
    });

    const followerClient = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `${follower.baseUrl}/trpc` })],
    });
    const runner = await followerClient.runners.create.mutate({
      name: 'Standby proxy runner',
      runnerNumber: 'NET-1',
    });
    assert.equal(runner.runnerNumber, 'NET-1');

    await waitFor(async () => {
      const states = await Promise.all([
        fetchState(leaderPort),
        fetchState(followerPort),
      ]);
      return states.every((state) => state.runners.some((item) => item.id === runner.id));
    });
    assert.equal((await fetchClusterStatus(followerPort)).lastAppliedSeq, 2);
  } catch (error) {
    throw withServerOutput(error, leader, follower);
  } finally {
    await Promise.all([stopServer(leader), stopServer(follower)]);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('three hosts elect a replacement primary and keep accepting standby writes', { timeout: 25_000 }, async () => {
  const testRoot = path.resolve(`.tmp-test-cluster-failover-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  const servers: Array<RunningServer | null> = [null, null, null];

  try {
    servers[0] = await startApolloonServer({
      port: ports[0],
      dataPath: path.join(testRoot, 'host-1'),
      peers: [ports[1], ports[2]],
      bootstrapLeader: true,
    });
    servers[1] = await startApolloonServer({
      port: ports[1],
      dataPath: path.join(testRoot, 'host-2'),
      peers: [ports[0], ports[2]],
    });
    servers[2] = await startApolloonServer({
      port: ports[2],
      dataPath: path.join(testRoot, 'host-3'),
      peers: [ports[0], ports[1]],
    });

    await waitFor(async () => {
      const statuses = await Promise.all(ports.map(fetchClusterStatus));
      return statuses.filter((status) => status.role === 'leader').length === 1
        && statuses.filter((status) => status.role === 'follower').length === 2;
    });

    const initialStandbyClient = createClient(ports[1]);
    const firstRunner = await initialStandbyClient.runners.create.mutate({
      name: 'Before failover',
      runnerNumber: 'NET-BEFORE',
    });
    await waitFor(async () => {
      const states = await Promise.all(ports.map(fetchState));
      return states.every((state) => state.runners.some((runner) => runner.id === firstRunner.id));
    });

    await stopServer(servers[0]);
    servers[0] = null;
    const remainingPorts = ports.slice(1);
    await waitFor(async () => {
      const statuses = await Promise.all(remainingPorts.map(fetchClusterStatus));
      return statuses.filter((status) => status.role === 'leader').length === 1
        && statuses.filter((status) => status.role === 'follower').length === 1;
    }, 8_000);

    const statuses = await Promise.all(remainingPorts.map(fetchClusterStatus));
    const standbyIndex = statuses.findIndex((status) => status.role === 'follower');
    assert.notEqual(standbyIndex, -1);
    const postFailoverClient = createClient(remainingPorts[standbyIndex]);
    const secondRunner = await postFailoverClient.runners.create.mutate({
      name: 'After failover',
      runnerNumber: 'NET-AFTER',
    });

    await waitFor(async () => {
      const states = await Promise.all(remainingPorts.map(fetchState));
      return states.every((state) =>
        state.runners.some((runner) => runner.id === firstRunner.id)
        && state.runners.some((runner) => runner.id === secondRunner.id)
      );
    });
    const finalStatuses = await Promise.all(remainingPorts.map(fetchClusterStatus));
    assert.ok(finalStatuses.every((status) => status.lastAppliedSeq === 2));
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('overlapping leader heartbeats cannot roll a follower back to an older snapshot', { timeout: 15_000 }, async () => {
  const testRoot = path.resolve(`.tmp-test-cluster-pull-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  const followerPort = await freePort();
  const fakeLeaderPort = await freePort();
  let follower: RunningServer | null = null;
  let requestCount = 0;
  let operations: ClusterOperationFixture[] = [];

  const fakeLeader = http.createServer((request, response) => {
    if (!request.url?.startsWith('/api/cluster/operations')) {
      response.statusCode = 404;
      response.end();
      return;
    }

    const requestNumber = ++requestCount;
    const after = Number(new URL(request.url, `http://127.0.0.1:${fakeLeaderPort}`).searchParams.get('after') || 0);
    const available = operations.filter((operation) => operation.seq > after);
    const selected = requestNumber === 1 ? available.slice(0, 2) : available;
    const delayMs = requestNumber === 1 ? 250 : 10;
    setTimeout(() => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        hostId: 'fake-leader',
        term: 1,
        role: 'leader',
        lastSeq: 3,
        operations: selected,
      }));
    }, delayMs);
  });

  try {
    await listen(fakeLeader, fakeLeaderPort);
    follower = await startApolloonServer({
      port: followerPort,
      dataPath: testRoot,
      peers: [fakeLeaderPort],
      heartbeatMs: 10_000,
      electionMinMs: 20_000,
    });

    const snapshot = await fetchState(followerPort);
    const modes: PublicRecordMode[] = ['off', 'hour', 'two_hour'];
    operations = modes.map((publicRecordMode, index) => ({
      seq: index + 1,
      id: `operation-${index + 1}`,
      term: 1,
      originHostId: 'fake-leader',
      type: 'settings.updatePublicRecordMode',
      payload: {
        snapshot: {
          ...snapshot,
          settings: { publicRecordMode },
        },
      },
      createdAt: 1_000 + index,
      appliedAt: 1_000 + index,
    }));

    void sendHeartbeat(followerPort, fakeLeaderPort);
    await waitFor(() => requestCount === 1);
    void sendHeartbeat(followerPort, fakeLeaderPort);

    await waitFor(async () => {
      const [status, state] = await Promise.all([
        fetchClusterStatus(followerPort),
        fetchState(followerPort),
      ]);
      return status.lastAppliedSeq === 3 && state.settings.publicRecordMode === 'two_hour';
    });
    assert.equal(requestCount, 2);
  } catch (error) {
    throw withServerOutput(error, follower);
  } finally {
    await stopServer(follower);
    await closeHttpServer(fakeLeader);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('an unresponsive peer cannot start overlapping election storms', { timeout: 10_000 }, async () => {
  const testRoot = path.resolve(`.tmp-test-cluster-election-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  const appPort = await freePort();
  const stalledPeerPort = await freePort();
  const sockets = new Set<Socket>();
  const stalledPeer = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let server: RunningServer | null = null;

  try {
    await listen(stalledPeer, stalledPeerPort);
    server = await startApolloonServer({
      port: appPort,
      dataPath: testRoot,
      peers: [stalledPeerPort],
      heartbeatMs: 50,
      electionMinMs: 100,
      requestTimeoutMs: 120,
    });

    await delay(450);
    const status = await fetchClusterStatus(appPort);
    assert.equal(status.role, 'candidate');
    assert.ok(status.term >= 1, `expected at least one election, received term ${status.term}`);
    assert.ok(status.term <= 3, `overlapping elections advanced the term to ${status.term}`);
  } catch (error) {
    throw withServerOutput(error, server);
  } finally {
    await stopServer(server);
    for (const socket of sockets) socket.destroy();
    await closeNetServer(stalledPeer);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

type ClusterOperationFixture = {
  seq: number;
  id: string;
  term: number;
  originHostId: string;
  type: string;
  payload: { snapshot: AppSnapshot };
  createdAt: number;
  appliedAt: number;
};

async function startApolloonServer(options: {
  port: number;
  dataPath: string;
  peers: number[];
  bootstrapLeader?: boolean;
  heartbeatMs?: number;
  electionMinMs?: number;
  requestTimeoutMs?: number;
  clusterEnabled?: boolean;
}): Promise<RunningServer> {
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const child = spawn(process.execPath, ['dist-server/server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_PATH: options.dataPath,
      PORT: String(options.port),
      PUBLIC_APP_PORT: String(options.port),
      PUBLIC_HOST: '127.0.0.1',
      CLUSTER_ENABLED: options.clusterEnabled === false ? 'false' : 'true',
      APOLLOON_CLUSTER: 'false',
      CLUSTER_BOOTSTRAP_LEADER: options.bootstrapLeader ? 'true' : 'false',
      CLUSTER_PEERS: options.peers.map((port) => `http://127.0.0.1:${port}`).join(','),
      CLUSTER_DISCOVERY: 'false',
      CLUSTER_SCAN: 'false',
      CLUSTER_MIN_HOSTS: '2',
      CLUSTER_HEARTBEAT_MS: String(options.heartbeatMs ?? 75),
      CLUSTER_ELECTION_MIN_MS: String(options.electionMinMs ?? 400),
      CLUSTER_ELECTION_JITTER_MS: '25',
      CLUSTER_REQUEST_TIMEOUT_MS: String(options.requestTimeoutMs ?? 250),
      CLUSTER_PROXY_TIMEOUT_MS: '1_000',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
  const running = { process: child, baseUrl, output: () => output };

  await waitFor(async () => {
    if (child.exitCode != null) {
      throw new Error(`Server stopped with exit code ${child.exitCode}: ${output}`);
    }
    try {
      return (await fetch(`${baseUrl}/api/cluster/status`)).ok;
    } catch {
      return false;
    }
  }, 8_000);
  return running;
}

async function sendHeartbeat(followerPort: number, leaderPort: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${followerPort}/api/cluster/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      term: 1,
      leaderId: 'fake-leader',
      leaderUrl: `http://127.0.0.1:${leaderPort}`,
      lastSeq: 3,
    }),
  });
  assert.equal(response.status, 200);
}

async function fetchState(port: number): Promise<AppSnapshot> {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(response.status, 200);
  return response.json() as Promise<AppSnapshot>;
}

async function fetchClusterStatus(port: number): Promise<{
  role: string;
  term: number;
  lastAppliedSeq: number;
}> {
  const response = await fetch(`http://127.0.0.1:${port}/api/cluster/status`);
  assert.equal(response.status, 200);
  return response.json() as Promise<{ role: string; term: number; lastAppliedSeq: number }>;
}

function createClient(port: number) {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `http://127.0.0.1:${port}/trpc` })],
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error('Condition timed out');
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await closeNetServer(server);
  return port;
}

async function listen(server: net.Server | http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.process.exitCode != null) return;
  server.process.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => server.process.once('exit', () => resolve())),
    delay(1_500),
  ]);
  if (server.process.exitCode == null) server.process.kill('SIGKILL');
}

async function closeHttpServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function closeNetServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function withServerOutput(error: unknown, ...servers: Array<RunningServer | null>): Error {
  const details = servers
    .filter((server): server is RunningServer => Boolean(server))
    .map((server) => `${server.baseUrl}\n${server.output()}`)
    .join('\n');
  return new Error(`${error instanceof Error ? error.stack || error.message : String(error)}\n${details}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
