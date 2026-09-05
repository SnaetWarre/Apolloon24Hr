import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import Papa from 'papaparse';
import { io } from 'socket.io-client';
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

const CLUSTER_ID = 'cluster-e2e-local-first';
const CLUSTER_SECRET = 'cluster-e2e-secret';

test('HTTP security blocks foreign origins, rebinding hosts and unauthenticated body parsing', async () => {
  const root = testRoot('http-security');
  const server = await startServer({ port: await freePort(), dataPath: root });
  try {
    for (const headers of [
      { origin: 'https://unrelated.example' },
      { origin: 'null' },
      { 'sec-fetch-site': 'cross-site' },
      { host: 'unrelated.example', origin: 'http://unrelated.example' },
    ]) {
      const response = await fetch(`${server.baseUrl}/api/cluster/status`, { headers });
      assert.equal(response.status, 403);
      await response.arrayBuffer();
    }
    const sameOrigin = await fetch(`${server.baseUrl}/api/state`, { headers: { origin: server.baseUrl } });
    assert.equal(sameOrigin.status, 200);
    await sameOrigin.arrayBuffer();
    const unicodePairing = await fetch(`${server.baseUrl}/api/cluster/bootstrap?code=${encodeURIComponent('😀😀😀😀')}`);
    assert.equal(unicodePairing.status, 401);
    await unicodePairing.arrayBuffer();
    const unauthorized = await fetch(`${server.baseUrl}/api/cluster/sync/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{malformed json',
    });
    assert.equal(unauthorized.status, 401);
    await unauthorized.arrayBuffer();
    const malformed = await fetch(`${server.baseUrl}/api/backups`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{malformed json',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { ok: false, error: 'invalid request body' });
    const oversized = await fetch(`${server.baseUrl}/api/backups`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(8 * 1_024 ** 2) }),
    });
    assert.equal(oversized.status, 413);
    await oversized.arrayBuffer();
    assert.equal((await fetch(`${server.baseUrl}/api/health`)).status, 200);
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cluster credentials and pairing codes are never forwarded through redirects', async () => {
  const root = testRoot('cluster-redirect');
  const [redirectPort, destinationPort] = await Promise.all([freePort(), freePort()]);
  let redirectedRequests = 0;
  let receivedProbes = 0;
  const destination = http.createServer((req, res) => {
    req.resume(); redirectedRequests += 1; res.end('{}');
  });
  const redirector = http.createServer((req, res) => {
    req.resume(); receivedProbes += 1;
    res.writeHead(307, { location: `http://127.0.0.1:${destinationPort}/capture` });
    res.end();
  });
  await Promise.all([
    new Promise<void>((resolve) => destination.listen(destinationPort, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => redirector.listen(redirectPort, '127.0.0.1', resolve)),
  ]);
  let backend: RunningServer | null = null;
  try {
    backend = await startServer({ port: await freePort(), dataPath: root, peers: [redirectPort] });
    await waitFor(async () => receivedProbes >= 2);
    const joined = await fetch(`${backend.baseUrl}/api/cluster/join`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remoteUrl: `http://127.0.0.1:${redirectPort}`, pairingCode: 'AAAAAAAA' }),
    });
    assert.equal(joined.status, 500);
    await joined.arrayBuffer();
    assert.equal(redirectedRequests, 0);
  } finally {
    await stopServer(backend);
    for (const listener of [redirector, destination]) {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Socket.IO refuses a foreign web origin and accepts the app origin', async () => {
  const root = testRoot('socket-origin');
  const server = await startServer({ port: await freePort(), dataPath: root });
  try {
    for (const [origin, expectedEvent] of [
      ['https://unrelated.example', 'connect_error'], [server.baseUrl, 'connect'],
    ]) {
      const socket = io(server.baseUrl, {
        transports: ['websocket'], extraHeaders: { Origin: origin }, reconnection: false, autoConnect: false,
      });
      try {
        let connectionEvent = '';
        socket.on('connect', () => { connectionEvent = 'connect'; });
        socket.on('connect_error', () => { connectionEvent = 'connect_error'; });
        socket.connect();
        await waitFor(async () => Boolean(connectionEvent));
        assert.equal(connectionEvent, expectedEvent);
      } finally { socket.disconnect(); }
    }
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Vite development proxy preserves the browser origin for the backend guard', async () => {
  const root = testRoot('dev-origin');
  const backend = await startServer({ port: await freePort(), dataPath: root });
  const { createServer } = await import('vite');
  const previousApiPort = process.env.VITE_DEV_API_PORT;
  process.env.VITE_DEV_API_PORT = String(backend.port);
  const frontendPort = await freePort();
  const frontend = await createServer({
    cacheDir: path.join(root, 'vite-cache'),
    server: { host: '127.0.0.1', port: frontendPort, strictPort: true },
  });
  try {
    await frontend.listen();
    const frontendUrl = `http://127.0.0.1:${frontendPort}`;
    const response = await fetch(`${frontendUrl}/api/state`, { headers: { origin: frontendUrl } });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  } finally {
    await frontend.close();
    if (previousApiPort === undefined) delete process.env.VITE_DEV_API_PORT;
    else process.env.VITE_DEV_API_PORT = previousApiPort;
    await stopServer(backend);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lap CSV exports escape user-controlled spreadsheet formulas', async () => {
  const root = testRoot('csv-formula');
  const server = await startServer({ port: await freePort(), dataPath: root });
  try {
    const client = createClient(server.port);
    const runner = await client.runners.create.mutate({ name: '=1+1', runnerNumber: '+123', status: 'waiting' });
    await client.race.startNext.mutate({ activeRunnerId: null, activeStartedAt: null });
    const activeRace = (await fetchState(server.port)).race;
    await client.race.handoff.mutate({ activeRunnerId: runner.id, activeStartedAt: activeRace.activeStartedAt });
    const csv = await (await fetch(`${server.baseUrl}/api/export/laps.csv`)).text();
    const rows = Papa.parse<Record<string, string>>(csv, { header: true }).data;
    assert.equal(rows[0].name, "'=1+1");
    assert.equal(rows[0].runner_number, "'+123");
    assert.equal((await fetchState(server.port)).runners[0].name, '=1+1');
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    const healthResponse = await fetch(`${server.baseUrl}/api/health`);
    const health = (await healthResponse.json()) as {
      ok: boolean;
      releaseId: string | null;
      database: { ready: boolean; schemaVersion: number };
    };
    assert.equal(healthResponse.status, 200);
    assert.equal(health.ok, true);
    assert.equal(health.releaseId, 'e2e-test-release');
    assert.equal(health.database.ready, true);
    assert.ok(health.database.schemaVersion > 0);
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

test('incompatible app versions are blocked before cluster synchronization', { timeout: 15_000 }, async () => {
  const root = testRoot('version-skew');
  const ports = await Promise.all([freePort(), freePort()]);
  const servers: RunningServer[] = [];
  try {
    servers.push(
      await startServer({
        port: ports[0],
        dataPath: path.join(root, 'old'),
        peers: [ports[1]],
        appVersion: '1.0.0',
        minimumAppVersion: '1.0.0',
      })
    );
    servers.push(
      await startServer({
        port: ports[1],
        dataPath: path.join(root, 'new'),
        peers: [ports[0]],
        appVersion: '2.0.0',
        minimumAppVersion: '2.0.0',
      })
    );

    await waitFor(async () => {
      const statuses = await Promise.all(ports.map(fetchStatus));
      return statuses.every(
        (status) =>
          status.connectedHosts === 1 &&
          status.incompatiblePeerCount === 1 &&
          status.peers.some((peer) => /Upgrade vereist/.test(peer.compatibilityError || ''))
      );
    });

    const statuses = await Promise.all(ports.map(fetchStatus));
    assert.deepEqual(statuses.map((status) => status.compatibility.appVersion), ['1.0.0', '2.0.0']);
    assert.ok(statuses.every((status) => status.knownHosts === 2));
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manual backup endpoint produces a downloadable verified SQLite snapshot', { timeout: 15_000 }, async () => {
  const root = testRoot('manual-backup');
  const server = await startServer({
    port: await freePort(),
    dataPath: root,
    clusterEnabled: false,
  });
  try {
    await createClient(server.port).runners.create.mutate({
      name: 'Backup endpoint runner',
      runnerNumber: 'BACKUP-HTTP-1',
      _commandId: crypto.randomUUID(),
      _clientId: 'backup-test',
    });
    const createResponse = await fetch(`${server.baseUrl}/api/backups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'manual' }),
    });
    const created = (await createResponse.json()) as {
      ok: boolean;
      backup: { fileName: string; sha256: string; verified: boolean };
    };
    assert.equal(createResponse.status, 201);
    assert.equal(created.ok, true);
    assert.equal(created.backup.verified, true);

    const statusResponse = await fetch(`${server.baseUrl}/api/backups/status`);
    const status = (await statusResponse.json()) as {
      retainedCount: number;
      latest: { fileName: string } | null;
    };
    assert.equal(status.retainedCount, 1);
    assert.equal(status.latest?.fileName, created.backup.fileName);

    const manifestResponse = await fetch(
      `${server.baseUrl}/api/backups/latest/manifest`
    );
    const manifest = (await manifestResponse.json()) as {
      application: string;
      backup: { fileName: string; sha256: string };
      verification: { sqliteQuickCheck: string };
    };
    assert.equal(manifestResponse.ok, true);
    assert.equal(manifest.application, 'Apolloon');
    assert.equal(manifest.backup.fileName, created.backup.fileName);
    assert.equal(manifest.backup.sha256, created.backup.sha256);
    assert.equal(manifest.verification.sqliteQuickCheck, 'ok');

    const download = await fetch(`${server.baseUrl}/api/backups/latest`);
    assert.equal(
      download.ok,
      true,
      `HTTP ${download.status}: ${await download.clone().text()}\n${server.output()}`
    );
    const contents = Buffer.from(await download.arrayBuffer());
    assert.equal(download.headers.get('x-apolloon-backup-sha256'), created.backup.sha256);
    assert.equal(contents.subarray(0, 16).toString('binary'), 'SQLite format 3\u0000');

    const backupPath = path.join(root, 'backups', created.backup.fileName);
    const descriptor = fs.openSync(backupPath, 'r+');
    try {
      fs.writeSync(descriptor, Buffer.from([0xff]), 0, 1, 128);
    } finally {
      fs.closeSync(descriptor);
    }
    const corruptDownload = await fetch(`${server.baseUrl}/api/backups/latest`);
    assert.equal(corruptDownload.status, 409);
    assert.match(await corruptDownload.text(), /SHA-256|geverifieerd/i);
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
    const safetyMetadata = fs
      .readdirSync(path.join(joiner.dataPath, 'backups'))
      .filter((fileName) => fileName.endsWith('.sqlite.json'));
    assert.equal(safetyMetadata.length, 1);
    const safetyRecord = JSON.parse(
      fs.readFileSync(
        path.join(joiner.dataPath, 'backups', safetyMetadata[0]),
        'utf8'
      )
    ) as { reason: string; verified: boolean; sha256: string };
    assert.equal(safetyRecord.reason, 'pre-cluster-join');
    assert.equal(safetyRecord.verified, true);
    assert.match(safetyRecord.sha256, /^[0-9a-f]{64}$/);
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

test('timing control transfers while connected and emergency takeover waits for failure confirmation', { timeout: 30_000 }, async () => {
  const root = testRoot('timing-transfer');
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
    await waitFor(async () =>
      (await Promise.all(ports.map(fetchStatus))).every((status) => status.connectedHosts === 2)
    );
    const [aStatus, bStatus] = await Promise.all(ports.map(fetchStatus));
    const clientA = createClient(a.port);
    const clientB = createClient(b.port);
    await clientA.cluster.claimTimingControl.mutate({
      expectedControllerHostId: null,
      force: false,
      _commandId: crypto.randomUUID(),
      _clientId: 'a',
    });
    await waitFor(async () =>
      (await fetchStatus(b!.port)).timingControllerHostId === aStatus.hostId
    );

    await assert.rejects(
      () =>
        clientB.cluster.claimTimingControl.mutate({
          expectedControllerHostId: aStatus.hostId,
          force: false,
          _commandId: crypto.randomUUID(),
          _clientId: 'b',
        }),
      /nog bereikbaar|gecontroleerd over/i
    );

    await waitFor(async () => {
      const status = await fetchStatus(a.port);
      return status.peers.some(
        (peer) => peer.id === bStatus.hostId && peer.synchronized
      );
    });
    await clientA.cluster.transferTimingControl.mutate({
      targetHostId: bStatus.hostId,
      _commandId: crypto.randomUUID(),
      _clientId: 'a',
    });
    await waitFor(async () => {
      const statuses = await Promise.all(ports.map(fetchStatus));
      return statuses.every(
        (status) => status.timingControllerHostId === bStatus.hostId
      );
    });
    assert.equal((await fetchStatus(a.port)).timingControl.state, 'remote-reachable');
    assert.equal((await fetchStatus(b.port)).timingControl.state, 'local');

    await stopServer(b);
    b = null;
    await waitFor(async () => (await fetchStatus(a.port)).timingControl.takeoverAllowed, 5_000);
    const takeover = await clientA.cluster.claimTimingControl.mutate({
      expectedControllerHostId: bStatus.hostId,
      force: false,
      _commandId: crypto.randomUUID(),
      _clientId: 'a',
    });
    assert.equal(takeover.hostId, aStatus.hostId);
    assert.ok(takeover.generation >= 3);
    assert.equal((await fetchStatus(a.port)).timingControl.state, 'local');
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
      expectedControllerHostId: null,
      force: false,
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
    await waitFor(
      async () => (await fetchStatus(ports[1])).timingControl.forcedTakeoverAllowed,
      12_000
    );
    await clientB.cluster.claimTimingControl.mutate({
      expectedControllerHostId: (await fetchStatus(ports[1])).timingControllerHostId,
      force: true,
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
      protocol: 3,
      compatibility: {
        protocolVersion: 3,
        schemaVersion: 9,
        minimumSchemaVersion: 9,
        replicationFormatVersion: 1,
        minimumReplicationFormatVersion: 1,
        appVersion: '1.0.0',
        minimumAppVersion: '1.0.0',
        releaseId: 'e2e-test-release',
      },
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
  appVersion?: string;
  minimumAppVersion?: string;
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
      TIMING_TAKEOVER_GRACE_MS: '200',
      TIMING_FORCED_TAKEOVER_GRACE_MS: '400',
      BACKUP_ENABLED: 'false',
      APOLLOON_RELEASE_ID: 'e2e-test-release',
      APOLLOON_APP_VERSION: options.appVersion || '1.0.0',
      APOLLOON_MIN_COMPATIBLE_APP_VERSION:
        options.minimumAppVersion || options.appVersion || '1.0.0',
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
  const [stateResponse, historyResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/state`),
    fetch(`http://127.0.0.1:${port}/api/history`),
  ]);
  assert.equal(stateResponse.ok, true);
  assert.equal(historyResponse.ok, true);
  const [state, history] = await Promise.all([
    stateResponse.json() as Promise<LiveAppSnapshot>,
    historyResponse.json() as Promise<RaceHistory>,
  ]);
  return { ...state, laps: history.laps, events: history.events };
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
