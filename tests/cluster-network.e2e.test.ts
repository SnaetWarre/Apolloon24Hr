import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '../server/router.ts';
import { signDiscoveryPayload } from '../server/cluster-protocol.ts';
import type { ClusterStatus } from '../shared/schemas.ts';

const clusterId = 'network-recovery-test';
const clusterSecret = 'network-recovery-secret';
const compatibility = {
  protocolVersion: 3,
  schemaVersion: 12,
  minimumSchemaVersion: 12,
  replicationFormatVersion: 1,
  minimumReplicationFormatVersion: 1,
  appVersion: '2.0.0',
  minimumAppVersion: '2.0.0',
  releaseId: 'network-recovery-test',
};

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Network recovery condition timed out');
}

async function unusedTcpPort() {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

async function udpSocket() {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return socket;
}

async function startBackend(options: {
  retryMs?: number;
  timeoutMs?: number;
  discoveryPort?: number;
  syncIntervalMs?: number;
} = {}) {
  const port = await unusedTcpPort();
  const reservation = await udpSocket();
  const discoveryPort = options.discoveryPort ?? reservation.address().port;
  reservation.close();
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'apolloon-network-test-'));
  let serverOutput = '';
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_PATH: dataPath,
      PORT: String(port),
      PUBLIC_APP_PORT: String(port),
      PUBLIC_HOST: '',
      CLUSTER_ENABLED: 'true',
      CLUSTER_ID: clusterId,
      CLUSTER_SECRET: clusterSecret,
      CLUSTER_SELF_URL: `http://127.0.0.1:${port}`,
      CLUSTER_PEERS: '',
      CLUSTER_DISCOVERY: 'true',
      CLUSTER_DISCOVERY_PORT: String(discoveryPort),
      CLUSTER_DISCOVERY_ADDRESS: '127.0.0.1',
      CLUSTER_DISCOVERY_INTERVAL_MS: '50',
      CLUSTER_SYNC_INTERVAL_MS: String(options.syncIntervalMs ?? 50),
      CLUSTER_REQUEST_TIMEOUT_MS: String(options.timeoutMs ?? 250),
      CLUSTER_PEER_RETRY_MS: String(options.retryMs ?? 50),
      BACKUP_ENABLED: 'false',
      APOLLOON_APP_VERSION: '2.0.0',
      APOLLOON_MIN_COMPATIBLE_APP_VERSION: '2.0.0',
      APOLLOON_RELEASE_ID: compatibility.releaseId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const forceStop = setTimeout(() => child.kill('SIGKILL'), 2_000);
      await exited;
      clearTimeout(forceStop);
    }
    fs.rmSync(dataPath, { recursive: true, force: true });
  };
  try {
    await waitUntil(async () => {
      if (child.exitCode !== null) throw new Error(serverOutput);
      return (await fetch(`${baseUrl}/api/host-info`).catch(() => null))?.ok === true;
    });
  } catch (error) {
    await stop();
    throw new Error(`${String(error)}\n${serverOutput}`);
  }
  return {
    baseUrl,
    discoveryPort,
    output: () => serverOutput,
    status: async () => (await fetch(`${baseUrl}/api/cluster/status`)).json() as Promise<ClusterStatus>,
    stop,
  };
}

async function startPeer(options: { advertisedUrl?: string; delayMs?: number; hostId?: string } = {}) {
  const hostId = options.hostId ?? 'moving-laptop';
  let exchanges = 0;
  const advertisedUrl = options.advertisedUrl ?? '';
  const replyDelayMs = options.delayMs ?? 0;
  const pendingReplies = new Set<NodeJS.Timeout>();
  const listener = http.createServer((req, res) => {
    req.resume();
    exchanges += 1;
    const reply = () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        protocol: 3, compatibility, clusterId, hostId,
        url: advertisedUrl || baseUrl, vector: {}, operations: [], sentAt: Date.now(),
      }));
    };
    if (replyDelayMs) {
      const pendingReply = setTimeout(() => {
        pendingReplies.delete(pendingReply);
        reply();
      }, replyDelayMs);
      pendingReplies.add(pendingReply);
    } else reply();
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(listener.address() as net.AddressInfo).port}`;
  return {
    baseUrl,
    hostId,
    exchanges: () => exchanges,
    stop: async () => {
      for (const pendingReply of pendingReplies) clearTimeout(pendingReply);
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

async function announce(discoveryPort: number, url: string, hostId = 'moving-laptop') {
  const socket = await udpSocket();
  const packet = Buffer.from(JSON.stringify(signDiscoveryPayload({
    app: 'apolloon', protocol: 3, compatibility, clusterId, hostId,
    url, vector: {}, sentAt: Date.now(),
  }, clusterSecret)));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.send(packet, discoveryPort, '127.0.0.1', (error) => error ? reject(error) : resolve());
    });
  } finally {
    socket.close();
  }
}

const benchmarkEnabled = process.env.APOLLOON_RECOVERY_BENCHMARK === '1';

test('signed UDP address changes bypass the old address retry delay', { timeout: 60_000 }, async (context) => {
  const recoverySamplesMs: number[] = [];
  for (let repetition = 0; repetition < (benchmarkEnabled ? 6 : 1); repetition += 1) {
    const backend = await startBackend({ retryMs: 5_000 });
    const peer = await startPeer();
    try {
      const oldUrl = `http://127.0.0.1:${await unusedTcpPort()}`;
      await announce(backend.discoveryPort, oldUrl);
      await waitUntil(() => backend.output().includes(`Cluster sync with ${oldUrl} failed:`));
      const announcedAt = performance.now();
      await announce(backend.discoveryPort, peer.baseUrl);
      await waitUntil(async () => {
        const status = await backend.status();
        return status.connectedHosts === 2 && status.peers[0].url === peer.baseUrl;
      });
      const recoveryMs = performance.now() - announcedAt;
      const status = await backend.status();
      assert.equal(status.knownHosts, 2);
      assert.equal(status.peers[0].id, peer.hostId);
      if (benchmarkEnabled) {
        if (repetition > 0) recoverySamplesMs.push(recoveryMs);
      } else assert.ok(recoveryMs < 1_000, `New address took ${recoveryMs.toFixed(1)} ms`);
    } finally {
      await Promise.all([backend.stop(), peer.stop()]);
    }
  }
  if (benchmarkEnabled) context.diagnostic(JSON.stringify({ recoverySamplesMs }));
});

test('a connected peer falls back to its other discovered interface after transport loss', async () => {
  const backend = await startBackend({ retryMs: 5_000 });
  const oldPeer = await startPeer();
  const newPeer = await startPeer();
  let oldPeerStopped = false;
  try {
    await announce(backend.discoveryPort, oldPeer.baseUrl);
    await waitUntil(async () => (await backend.status()).connectedHosts === 2);
    await announce(backend.discoveryPort, newPeer.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await backend.status()).peers[0].url, oldPeer.baseUrl);
    await oldPeer.stop();
    oldPeerStopped = true;
    await waitUntil(async () => {
      const status = await backend.status();
      return status.connectedHosts === 2 && status.peers[0].url === newPeer.baseUrl;
    }, 1_500);
    assert.equal((await backend.status()).knownHosts, 2);
  } finally {
    await Promise.all([backend.stop(), newPeer.stop(), ...(oldPeerStopped ? [] : [oldPeer.stop()])]);
  }
});

async function forwardBackend(targetUrl: string, bindAddress: string, port = 0) {
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(new URL(req.url || '/', targetUrl), {
      method: req.method,
      headers: req.headers,
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(port, bindAddress, resolve));
  const boundPort = (proxy.address() as net.AddressInfo).port;
  return {
    url: `http://${bindAddress}:${boundPort}`,
    port: boundPort,
    stop: async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}

test('running databases catch up both ways after their peer endpoint moves without re-pairing', async () => {
  const controller = await startBackend();
  // Exercise push and pull through one route. The replica's own periodic probe
  // is delayed so it cannot bypass the transport outage via the controller URL.
  const replica = await startBackend({ syncIntervalMs: 60_000 });
  // Linux routes the entire 127/8 block locally without changing any adapters.
  // Other platforms exercise the same URL turnover with a changed port.
  const oldAddress = process.platform === 'linux' ? '127.0.0.2' : '127.0.0.1';
  const newAddress = process.platform === 'linux' ? '127.0.0.3' : '127.0.0.1';
  let replicaRoute = await forwardBackend(replica.baseUrl, oldAddress);
  const clientFor = (url: string) => createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `${url}/trpc` })],
  });
  const controllerClient = clientFor(controller.baseUrl);
  const replicaClient = clientFor(replica.baseUrl);
  const replicaHostId = (await replica.status()).hostId;
  try {
    await announce(controller.discoveryPort, replicaRoute.url, replicaHostId);
    await waitUntil(async () => (await controller.status()).connectedHosts === 2);
    const beforeMove = await controllerClient.runners.create.mutate({ name: 'Before move', runnerNumber: 'MOVE-0' });
    const runnerIds = async (url: string): Promise<string[]> => {
      const snapshot = await (await fetch(`${url}/api/state`)).json();
      return snapshot.runners.map((runner: { id: string }) => runner.id).sort();
    };
    await waitUntil(async () => (await runnerIds(replica.baseUrl)).includes(beforeMove.id));
    await replicaRoute.stop();
    await waitUntil(async () => (await controller.status()).connectedHosts === 1);
    const localWrite = await controllerClient.runners.create.mutate({ name: 'Controller offline', runnerNumber: 'MOVE-1' });
    const remoteWrite = await replicaClient.runners.create.mutate({ name: 'Replica offline', runnerNumber: 'MOVE-2' });
    replicaRoute = await forwardBackend(
      replica.baseUrl, newAddress, oldAddress === newAddress ? 0 : replicaRoute.port
    );
    await announce(controller.discoveryPort, replicaRoute.url, replicaHostId);
    const expectedIds = [beforeMove.id, localWrite.id, remoteWrite.id].sort();
    await waitUntil(async () => {
      const [controllerIds, replicaIds] = await Promise.all([
        runnerIds(controller.baseUrl), runnerIds(replica.baseUrl),
      ]);
      return JSON.stringify(controllerIds) === JSON.stringify(expectedIds) &&
        JSON.stringify(replicaIds) === JSON.stringify(expectedIds);
    });
    const status = await controller.status();
    assert.equal(status.connectedHosts, 2);
    assert.equal(status.knownHosts, 2);
    assert.equal(status.peers[0].id, replicaHostId);
    assert.equal(status.peers[0].url, replicaRoute.url);
  } finally {
    await Promise.all([controller.stop(), replica.stop(), replicaRoute.stop()]);
  }
});

test('sync keeps the reachable interface when a peer advertises another interface', async () => {
  const backend = await startBackend();
  const unreachableUrl = `http://127.0.0.1:${await unusedTcpPort()}`;
  const peer = await startPeer({ advertisedUrl: unreachableUrl });
  try {
    await announce(backend.discoveryPort, peer.baseUrl);
    await waitUntil(() => peer.exchanges() >= 1);
    // Repeated broadcasts on a second interface must not displace the proven route.
    for (let repetition = 0; repetition < 8; repetition += 1) {
      await announce(backend.discoveryPort, unreachableUrl);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const status = await backend.status();
    assert.equal(status.connectedHosts, 2);
    assert.equal(status.knownHosts, 2);
    assert.equal(status.peers[0].url, peer.baseUrl);
    assert.ok(peer.exchanges() >= 3);
  } finally {
    await Promise.all([backend.stop(), peer.stop()]);
  }
});

for (const [outcome, delayMs] of [['reply', 400], ['timeout', 2_000]] as const) {
test(`a late ${outcome} from the old address cannot undo rediscovery`, async () => {
  const backend = await startBackend({ timeoutMs: 1_000, retryMs: 5_000 });
  const oldPeer = await startPeer({ delayMs });
  const newPeer = await startPeer();
  try {
    await announce(backend.discoveryPort, oldPeer.baseUrl);
    await waitUntil(() => oldPeer.exchanges() >= 1);
    await announce(backend.discoveryPort, newPeer.baseUrl);
    await waitUntil(() => newPeer.exchanges() >= 1, 1_500);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const status = await backend.status();
    assert.equal(status.connectedHosts, 2);
    assert.equal(status.knownHosts, 2);
    assert.equal(status.peers[0].url, newPeer.baseUrl);
  } finally {
    await Promise.all([backend.stop(), oldPeer.stop(), newPeer.stop()]);
  }
});
}

test('inbound exchanges use the source interface instead of an unrelated advertised IP', async () => {
  const backend = await startBackend();
  const peer = await startPeer();
  try {
    const unrelatedInterface = new URL(peer.baseUrl);
    unrelatedInterface.hostname = '192.0.2.1';
    const response = await fetch(`${backend.baseUrl}/api/cluster/sync/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-apolloon-cluster-secret': clusterSecret },
      body: JSON.stringify({
        protocol: 3, compatibility, clusterId, hostId: peer.hostId,
        url: unrelatedInterface.toString(), vector: {}, operations: [], sentAt: Date.now(),
      }),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    await waitUntil(() => peer.exchanges() >= 2);
    const status = await backend.status();
    assert.equal(status.connectedHosts, 2);
    assert.equal(status.peers[0].url, peer.baseUrl);
  } finally {
    await Promise.all([backend.stop(), peer.stop()]);
  }
});

test('an address reassigned to another host cannot silently replace the expected identity', async () => {
  const backend = await startBackend();
  const replacementPeer = await startPeer({ hostId: 'replacement-laptop' });
  try {
    await announce(backend.discoveryPort, replacementPeer.baseUrl, 'original-laptop');
    await waitUntil(() => backend.output().includes('invalid sync response'));
    const status = await backend.status();
    assert.equal(status.connectedHosts, 1);
    assert.equal(status.peers[0].id, 'original-laptop');
  } finally {
    await Promise.all([backend.stop(), replacementPeer.stop()]);
  }
});

test('discovery rebinds after a temporarily occupied UDP port is released', async () => {
  const blocker = await udpSocket();
  const discoveryPort = blocker.address().port;
  const backend = await startBackend({ discoveryPort });
  const peer = await startPeer();
  let blockerClosed = false;
  try {
    await waitUntil(() => backend.output().includes('Cluster discovery error:'));
    await new Promise<void>((resolve) => blocker.close(resolve));
    blockerClosed = true;
    await waitUntil(async () => {
      await announce(discoveryPort, peer.baseUrl);
      return (await backend.status()).connectedHosts === 2;
    }, 2_000);
  } finally {
    if (!blockerClosed) blocker.close();
    await Promise.all([backend.stop(), peer.stop()]);
  }
});
