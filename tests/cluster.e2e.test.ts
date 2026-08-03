import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../server/router.ts';
import type { AppSnapshot, ClusterStatus } from '../shared/schemas.ts';

type RunningServer = {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  dataPath: string;
  output: () => string;
};

const CLUSTER_ID = 'cluster-e2e-local-first';
const CLUSTER_SECRET = 'cluster-e2e-secret';

test('standalone mode stays writable and rejects replication exchange', { timeout: 12_000 }, async () => {
  const root = testRoot('standalone');
  const server = await startServer({
    port: await freePort(),
    dataPath: root,
    clusterEnabled: false,
  });
  try {
    const runner = await createClient(server.port).runners.create.mutate({
      name: 'Solo runner',
      runnerNumber: 'SOLO-1',
      _commandId: crypto.randomUUID(),
      _clientId: 'test',
    });
    assert.equal(runner.runnerNumber, 'SOLO-1');
    assert.equal((await fetchStatus(server.port)).role, 'standalone');
    const response = await fetch(`${server.baseUrl}/api/cluster/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 404);
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two writable Electron databases exchange operations in both directions', { timeout: 20_000 }, async () => {
  const root = testRoot('two-way');
  const ports = await Promise.all([freePort(), freePort()]);
  const servers: RunningServer[] = [];
  try {
    servers.push(
      await startServer({
        port: ports[0],
        dataPath: path.join(root, 'a'),
        peers: [ports[1]],
      })
    );
    const first = await createClient(ports[0]).runners.create.mutate({
      name: 'Created while alone',
      runnerNumber: 'LOCAL-A',
      _commandId: crypto.randomUUID(),
      _clientId: 'browser-a',
    });

    servers.push(
      await startServer({
        port: ports[1],
        dataPath: path.join(root, 'b'),
        peers: [ports[0]],
      })
    );
    await waitFor(async () => {
      const [a, b] = await Promise.all(ports.map(fetchStatus));
      return a.connectedHosts === 2 && b.connectedHosts === 2;
    });
    await waitFor(async () =>
      (await fetchState(ports[1])).runners.some((runner) => runner.id === first.id)
    );

    const second = await createClient(ports[1]).runners.create.mutate({
      name: 'Created on B',
      runnerNumber: 'LOCAL-B',
      _commandId: crypto.randomUUID(),
      _clientId: 'browser-b',
    });
    await waitFor(async () =>
      (await fetchState(ports[0])).runners.some((runner) => runner.id === second.id)
    );

    const states = await Promise.all(ports.map(fetchState));
    assert.deepEqual(normalizeState(states[0]), normalizeState(states[1]));
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a disconnected node writes locally and catches up after restart', { timeout: 25_000 }, async () => {
  const root = testRoot('restart');
  const ports = await Promise.all([freePort(), freePort(), freePort()]);
  const servers: Array<RunningServer | null> = [null, null, null];
  try {
    for (let index = 0; index < ports.length; index += 1) {
      servers[index] = await startServer({
        port: ports[index],
        dataPath: path.join(root, String(index)),
        peers: ports.filter((_, peerIndex) => peerIndex !== index),
      });
    }
    await waitFor(async () =>
      (await Promise.all(ports.map(fetchStatus))).every((status) => status.connectedHosts === 3)
    );

    await stopServer(servers[2]);
    servers[2] = null;
    const aRunner = await createClient(ports[0]).runners.create.mutate({
      name: 'A while C offline',
      runnerNumber: 'OFF-A',
      _commandId: crypto.randomUUID(),
      _clientId: 'a',
    });
    const bRunner = await createClient(ports[1]).runners.create.mutate({
      name: 'B while C offline',
      runnerNumber: 'OFF-B',
      _commandId: crypto.randomUUID(),
      _clientId: 'b',
    });
    await waitFor(async () => {
      const states = await Promise.all(ports.slice(0, 2).map(fetchState));
      return states.every(
        (state) =>
          state.runners.some((runner) => runner.id === aRunner.id) &&
          state.runners.some((runner) => runner.id === bRunner.id)
      );
    });

    servers[2] = await startServer({
      port: ports[2],
      dataPath: path.join(root, '2'),
      peers: ports.slice(0, 2),
    });
    await waitFor(async () => {
      const state = await fetchState(ports[2]);
      return (
        state.runners.some((runner) => runner.id === aRunner.id) &&
        state.runners.some((runner) => runner.id === bRunner.id)
      );
    });
    const states = await Promise.all(ports.map(fetchState));
    assert.deepEqual(normalizeState(states[0]), normalizeState(states[1]));
    assert.deepEqual(normalizeState(states[1]), normalizeState(states[2]));
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('five nodes converge after concurrent low-volume writes', { timeout: 30_000 }, async () => {
  const root = testRoot('five');
  const ports = await Promise.all(Array.from({ length: 5 }, () => freePort()));
  const servers: RunningServer[] = [];
  try {
    for (let index = 0; index < ports.length; index += 1) {
      servers.push(
        await startServer({
          port: ports[index],
          dataPath: path.join(root, String(index)),
          peers: ports.filter((_, peerIndex) => peerIndex !== index),
        })
      );
    }
    await waitFor(async () =>
      (await Promise.all(ports.map(fetchStatus))).every((status) => status.connectedHosts === 5)
    , 12_000);

    await Promise.all(
      ports.map((port, index) =>
        createClient(port).runners.create.mutate({
          name: `Runner ${index}`,
          runnerNumber: `FIVE-${index}`,
          _commandId: crypto.randomUUID(),
          _clientId: `client-${index}`,
        })
      )
    );
    await waitFor(async () => {
      const states = await Promise.all(ports.map(fetchState));
      return states.every(
        (state) => state.runners.filter((runner) => runner.runnerNumber?.startsWith('FIVE-')).length === 5
      );
    }, 12_000);
    const states = await Promise.all(ports.map(fetchState));
    for (const state of states.slice(1)) {
      assert.deepEqual(normalizeState(states[0]), normalizeState(state));
    }
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('joining a creator laptop imports its database and preserves a recovery backup', { timeout: 25_000 }, async () => {
  const root = testRoot('join');
  const creatorPort = await freePort();
  const joinerPort = await freePort();
  const creator = await startServer({
    port: creatorPort,
    dataPath: path.join(root, 'creator'),
    clusterId: 'creator-cluster',
    clusterSecret: 'creator-secret',
  });
  const joiner = await startServer({
    port: joinerPort,
    dataPath: path.join(root, 'joiner'),
    clusterId: 'joiner-cluster',
    clusterSecret: 'joiner-secret',
  });
  try {
    const creatorRunner = await createClient(creatorPort).runners.create.mutate({
      name: 'Creator database wins',
      runnerNumber: 'CREATOR-1',
      _commandId: crypto.randomUUID(),
      _clientId: 'creator',
    });
    const replacedRunner = await createClient(joinerPort).runners.create.mutate({
      name: 'Will be backed up',
      runnerNumber: 'JOINER-OLD',
      _commandId: crypto.randomUUID(),
      _clientId: 'joiner',
    });
    const creatorStatus = await fetchStatus(creatorPort);
    const response = await fetch(`${joiner.baseUrl}/api/cluster/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        remoteUrl: creator.baseUrl,
        pairingCode: creatorStatus.pairingCode,
      }),
    });
    const result = (await response.json()) as { ok: boolean; backupFile: string; error?: string };
    assert.equal(response.ok, true, result.error);
    assert.equal(result.ok, true);
    assert.equal(
      fs.existsSync(path.join(joiner.dataPath, 'data', result.backupFile)),
      true
    );
    await waitFor(async () => {
      const state = await fetchState(joinerPort);
      return (
        state.runners.some((runner) => runner.id === creatorRunner.id) &&
        !state.runners.some((runner) => runner.id === replacedRunner.id)
      );
    });
    await waitFor(async () => {
      const [a, b] = await Promise.all([fetchStatus(creatorPort), fetchStatus(joinerPort)]);
      return a.clusterId === b.clusterId && a.connectedHosts === 2 && b.connectedHosts === 2;
    });

    const joinedWrite = await createClient(joinerPort).runners.create.mutate({
      name: 'Written after joining',
      runnerNumber: 'JOINED-1',
      _commandId: crypto.randomUUID(),
      _clientId: 'joiner',
    });
    await waitFor(async () =>
      (await fetchState(creatorPort)).runners.some((runner) => runner.id === joinedWrite.id)
    );
    assert.deepEqual(
      normalizeState(await fetchState(creatorPort)),
      normalizeState(await fetchState(joinerPort))
    );
  } catch (error) {
    throw withServerOutput(error, creator, joiner);
  } finally {
    await Promise.all([stopServer(creator), stopServer(joiner)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid replication batch cannot strand a valid operation in the log', { timeout: 20_000 }, async () => {
  const root = testRoot('atomic-batch');
  const source = await startServer({
    port: await freePort(),
    dataPath: path.join(root, 'source'),
  });
  const target = await startServer({
    port: await freePort(),
    dataPath: path.join(root, 'target'),
  });
  try {
    const sourceClient = createClient(source.port);
    const first = await sourceClient.runners.create.mutate({
      name: 'Atomic first',
      runnerNumber: 'ATOMIC-1',
      _commandId: crypto.randomUUID(),
      _clientId: 'source',
    });
    const second = await sourceClient.runners.create.mutate({
      name: 'Atomic second',
      runnerNumber: 'ATOMIC-2',
      _commandId: crypto.randomUUID(),
      _clientId: 'source',
    });
    const sourceStatus = await fetchStatus(source.port);
    const pullResponse = await postClusterExchange(source, {
      hostId: 'observer',
      url: 'http://127.0.0.1:59991',
      vector: {},
      operations: [],
    });
    assert.equal(pullResponse.ok, true);
    const pulled = (await pullResponse.json()) as { operations: Array<Record<string, unknown>> };
    assert.equal(pulled.operations.length, 2);

    const invalidOperations = [
      pulled.operations[0],
      { ...pulled.operations[1], checksum: '0'.repeat(64) },
    ];
    const invalidResponse = await postClusterExchange(target, {
      clusterId: sourceStatus.clusterId,
      hostId: sourceStatus.hostId,
      url: source.baseUrl,
      vector: { [sourceStatus.hostId]: 2 },
      operations: invalidOperations,
    });
    assert.equal(invalidResponse.status, 500);
    assert.equal(
      (await fetchState(target.port)).runners.some((runner) => runner.id === first.id),
      false
    );
    assert.equal((await fetchStatus(target.port)).knownHosts, 1);

    const retryResponse = await postClusterExchange(target, {
      clusterId: sourceStatus.clusterId,
      hostId: sourceStatus.hostId,
      url: source.baseUrl,
      vector: { [sourceStatus.hostId]: 2 },
      operations: pulled.operations,
    });
    assert.equal(retryResponse.ok, true);
    const targetRunnerIds = new Set(
      (await fetchState(target.port)).runners.map((runner) => runner.id)
    );
    assert.equal(targetRunnerIds.has(first.id), true);
    assert.equal(targetRunnerIds.has(second.id), true);
  } catch (error) {
    throw withServerOutput(error, source, target);
  } finally {
    await Promise.all([stopServer(source), stopServer(target)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a known peer changing address replaces its stale URL instead of duplicating the laptop', { timeout: 20_000 }, async () => {
  const root = testRoot('peer-address-change');
  const ports = await Promise.all([freePort(), freePort()]);
  const a = await startServer({
    port: ports[0],
    dataPath: path.join(root, 'a'),
    peers: [ports[1]],
  });
  let b: RunningServer | null = await startServer({
    port: ports[1],
    dataPath: path.join(root, 'b'),
    peers: [ports[0]],
  });
  try {
    await waitFor(async () => (await fetchStatus(a.port)).connectedHosts === 2);
    const bStatus = await fetchStatus(b.port);
    await stopServer(b);
    b = null;

    const replacementUrl = `http://127.0.0.1:${await freePort()}`;
    const response = await postClusterExchange(a, {
      hostId: bStatus.hostId,
      url: replacementUrl,
      vector: {},
      operations: [],
    });
    assert.equal(response.ok, true);

    const status = await fetchStatus(a.port);
    const matchingPeers = status.peers.filter((peer) => peer.id === bStatus.hostId);
    assert.equal(matchingPeers.length, 1);
    assert.equal(matchingPeers[0].url, replacementUrl);
    assert.equal(status.knownHosts, 2);
  } catch (error) {
    throw withServerOutput(error, a, b);
  } finally {
    await Promise.all([stopServer(a), stopServer(b)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent offline edits of the same runner converge in canonical order', { timeout: 30_000 }, async () => {
  const root = testRoot('same-runner');
  const ports = await Promise.all([freePort(), freePort()]);
  let a: RunningServer | null = null;
  let b: RunningServer | null = null;
  try {
    a = await startServer({
      port: ports[0],
      dataPath: path.join(root, 'a'),
      peers: [ports[1]],
    });
    b = await startServer({
      port: ports[1],
      dataPath: path.join(root, 'b'),
      peers: [ports[0]],
    });
    const runner = await createClient(ports[0]).runners.create.mutate({
      name: 'Shared original',
      runnerNumber: 'SHARED-1',
      _commandId: crypto.randomUUID(),
      _clientId: 'a',
    });
    await waitFor(async () =>
      (await fetchState(ports[1])).runners.some((item) => item.id === runner.id)
    );

    await stopServer(b);
    b = null;
    await createClient(ports[0]).runners.update.mutate({
      id: runner.id,
      fields: { name: 'Edited offline on A' },
      _commandId: crypto.randomUUID(),
      _clientId: 'a',
    });
    await stopServer(a);
    a = null;

    b = await startServer({
      port: ports[1],
      dataPath: path.join(root, 'b'),
    });
    await createClient(ports[1]).runners.update.mutate({
      id: runner.id,
      fields: { name: 'Edited offline on B' },
      _commandId: crypto.randomUUID(),
      _clientId: 'b',
    });
    await stopServer(b);
    b = null;

    a = await startServer({
      port: ports[0],
      dataPath: path.join(root, 'a'),
      peers: [ports[1]],
    });
    b = await startServer({
      port: ports[1],
      dataPath: path.join(root, 'b'),
      peers: [ports[0]],
    });
    await waitFor(async () => {
      const states = await Promise.all(ports.map(fetchState));
      const names = states.map(
        (state) => state.runners.find((item) => item.id === runner.id)?.name
      );
      return Boolean(names[0] && names[0] === names[1]);
    }, 12_000);
    assert.deepEqual(
      normalizeState(await fetchState(ports[0])),
      normalizeState(await fetchState(ports[1]))
    );
  } catch (error) {
    throw withServerOutput(error, a, b);
  } finally {
    await Promise.all([stopServer(a), stopServer(b)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('split timing histories pause timing and can be resolved from the chosen laptop', { timeout: 35_000 }, async () => {
  const root = testRoot('timing-conflict');
  const ports = await Promise.all([freePort(), freePort()]);
  let a: RunningServer | null = null;
  let b: RunningServer | null = null;
  try {
    a = await startServer({
      port: ports[0],
      dataPath: path.join(root, 'a'),
      peers: [ports[1]],
    });
    b = await startServer({
      port: ports[1],
      dataPath: path.join(root, 'b'),
      peers: [ports[0]],
    });
    const clientA = createClient(ports[0]);
    const runner = await clientA.runners.create.mutate({
      name: 'Timing runner',
      runnerNumber: 'TIME-1',
      _commandId: crypto.randomUUID(),
      _clientId: 'a',
    });
    await clientA.runners.setStatus.mutate({
      id: runner.id,
      status: 'waiting',
      _commandId: crypto.randomUUID(),
      _clientId: 'a',
    });
    await clientA.cluster.claimTimingControl.mutate({
      _commandId: crypto.randomUUID(),
      _clientId: 'a',
    });
    await waitFor(async () =>
      (await fetchState(ports[1])).runners.some(
        (item) => item.id === runner.id && item.status === 'waiting'
      )
    );

    await stopServer(b);
    b = null;
    await clientA.race.startNext.mutate({
      activeRunnerId: null,
      activeStartedAt: null,
      _commandId: crypto.randomUUID(),
      _clientId: 'a',
    });
    await stopServer(a);
    a = null;

    b = await startServer({
      port: ports[1],
      dataPath: path.join(root, 'b'),
    });
    const clientB = createClient(ports[1]);
    await clientB.cluster.claimTimingControl.mutate({
      _commandId: crypto.randomUUID(),
      _clientId: 'b',
    });
    await clientB.race.startNext.mutate({
      activeRunnerId: null,
      activeStartedAt: null,
      _commandId: crypto.randomUUID(),
      _clientId: 'b',
    });
    const bBranchStartedAt = (await fetchState(ports[1])).race.activeStartedAt;
    const bHostId = (await fetchStatus(ports[1])).hostId;
    assert.ok(bBranchStartedAt);
    await stopServer(b);
    b = null;

    a = await startServer({
      port: ports[0],
      dataPath: path.join(root, 'a'),
      peers: [ports[1]],
    });
    b = await startServer({
      port: ports[1],
      dataPath: path.join(root, 'b'),
      peers: [ports[0]],
    });
    await waitFor(async () => {
      const statuses = await Promise.all(ports.map(fetchStatus));
      return statuses.every((status) => status.conflictCount === 1);
    }, 12_000);
    assert.deepEqual(
      normalizeState(await fetchState(ports[0])),
      normalizeState(await fetchState(ports[1]))
    );

    const conflictsResponse = await fetch(`${a.baseUrl}/api/cluster/conflicts`);
    const conflicts = (await conflictsResponse.json()) as Array<{
      id: string;
      kind: string;
      operations: Array<{ id: string; originHostId: string }>;
    }>;
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, 'timing');
    const selectedOperationId = conflicts[0].operations.find(
      (operation) => operation.originHostId === bHostId
    )?.id;
    assert.ok(selectedOperationId);
    await createClient(ports[0]).cluster.resolveConflict.mutate({
      conflictId: conflicts[0].id,
      selectedOperationId,
      _commandId: crypto.randomUUID(),
      _clientId: 'operator',
    });
    await waitFor(async () =>
      (await Promise.all(ports.map(fetchStatus))).every(
        (status) => status.conflictCount === 0
      )
    , 12_000);
    assert.deepEqual(
      normalizeState(await fetchState(ports[0])),
      normalizeState(await fetchState(ports[1]))
    );
    assert.equal((await fetchState(ports[0])).race.activeStartedAt, bBranchStartedAt);
  } catch (error) {
    throw withServerOutput(error, a, b);
  } finally {
    await Promise.all([stopServer(a), stopServer(b)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reusing a command id is exactly-once on the local database', { timeout: 12_000 }, async () => {
  const root = testRoot('idempotent');
  const server = await startServer({ port: await freePort(), dataPath: root });
  try {
    const client = createClient(server.port);
    const commandId = crypto.randomUUID();
    const input = {
      name: 'Exactly once',
      runnerNumber: 'ONCE-1',
      _commandId: commandId,
      _clientId: 'same-client',
    };
    const first = await client.runners.create.mutate(input);
    const second = await client.runners.create.mutate(input);
    assert.equal(first.id, second.id);
    assert.equal(
      (await fetchState(server.port)).runners.filter((runner) => runner.runnerNumber === 'ONCE-1').length,
      1
    );
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createClient(port: number) {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `http://127.0.0.1:${port}/trpc` })],
  });
}

function postClusterExchange(
  server: RunningServer,
  input: {
    clusterId?: string;
    hostId: string;
    url: string;
    vector: Record<string, number>;
    operations: unknown[];
  }
): Promise<Response> {
  return fetch(`${server.baseUrl}/api/cluster/sync/exchange`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-apolloon-cluster-secret': CLUSTER_SECRET,
    },
    body: JSON.stringify({
      protocol: 2,
      clusterId: input.clusterId || CLUSTER_ID,
      hostId: input.hostId,
      url: input.url,
      vector: input.vector,
      operations: input.operations,
      sentAt: Date.now(),
    }),
  });
}

async function startServer(options: {
  port: number;
  dataPath: string;
  peers?: number[];
  clusterEnabled?: boolean;
  clusterId?: string;
  clusterSecret?: string;
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
      CLUSTER_ID: options.clusterId || CLUSTER_ID,
      CLUSTER_SECRET: options.clusterSecret || CLUSTER_SECRET,
      CLUSTER_SELF_URL: `http://127.0.0.1:${options.port}`,
      CLUSTER_PEERS: (options.peers || []).map((port) => `http://127.0.0.1:${port}`).join(','),
      CLUSTER_DISCOVERY: 'false',
      CLUSTER_SCAN: 'false',
      CLUSTER_SYNC_INTERVAL_MS: '50',
      CLUSTER_REQUEST_TIMEOUT_MS: '250',
      CLUSTER_PEER_RETRY_MS: '50',
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
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    return (await fetch(`${server.baseUrl}/api/host-info`).catch(() => null))?.ok === true;
  });
  return server;
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.process.exitCode !== null) return;
  server.process.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => server.process.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (server.process.exitCode === null) server.process.kill('SIGKILL');
}

async function fetchState(port: number): Promise<AppSnapshot> {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.equal(response.ok, true);
  return response.json() as Promise<AppSnapshot>;
}

async function fetchStatus(port: number): Promise<ClusterStatus> {
  const response = await fetch(`http://127.0.0.1:${port}/api/cluster/status`);
  assert.equal(response.ok, true);
  return response.json() as Promise<ClusterStatus>;
}

function normalizeState(state: AppSnapshot): unknown {
  return {
    runners: state.runners.slice().sort((a, b) => a.id.localeCompare(b.id)),
    labels: state.labels.slice().sort((a, b) => a.id.localeCompare(b.id)),
    race: state.race,
    laps: state.laps.slice().sort((a, b) => a.id.localeCompare(b.id)),
    events: state.events.slice().sort((a, b) => a.id.localeCompare(b.id)),
    temporaryTeams: state.temporaryTeams.slice().sort((a, b) => a.labelId.localeCompare(b.labelId)),
    settings: state.settings,
  };
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

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 8_000,
  intervalMs = 50
): Promise<void> {
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
