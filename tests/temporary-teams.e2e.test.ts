import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { io, type Socket } from 'socket.io-client';
import type { AppRouter } from '../server/router.ts';
import type { AppSnapshot, TemporaryTeam } from '../shared/schemas.ts';
import { buildLabelComparisons, filterLaps } from '../src/lib/analysis.ts';

const dataPath = path.resolve(`.tmp-test-temporary-teams-e2e-${process.pid}`);

test('temporary night teams work through HTTP, realtime, analysis, exports, and restart', { timeout: 45_000 }, async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: ChildProcess | null = null;
  let socket: Socket | null = null;
  let serverOutput = '';

  try {
    ({ process: server, output: serverOutput } = await startServer(port));
    const client = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `${baseUrl}/trpc` })],
    });

    let connectedRevision: number | null = null;
    let initialBootstrapCount = 0;
    socket = io(baseUrl, { transports: ['websocket'], reconnection: false, autoConnect: false });
    socket.on('state:revision', (revision: number) => {
      connectedRevision = revision;
    });
    socket.on('bootstrap', () => {
      initialBootstrapCount += 1;
    });
    socket.connect();
    await waitForSocket(socket);
    await waitFor(() => connectedRevision !== null);
    const initialState = await fetchState(baseUrl);
    assert.equal(connectedRevision, initialState.revision);
    assert.equal(initialBootstrapCount, 0);
    const realtimeTeams: TemporaryTeam[][] = [];
    socket.on('temporary-teams:patched', (teams: TemporaryTeam[]) => realtimeTeams.push(teams));

    const labels = await client.labels.list.query();
    const blue = labels.find((label) => label.name === 'Speedteam Blue');
    const white = labels.find((label) => label.name === 'Speedteam White');
    assert.ok(blue);
    assert.ok(white);

    const alice = await client.runners.create.mutate({
      name: 'E2E Alice',
      runnerNumber: 'E2E-1',
      labels: [blue.id],
    });
    const bob = await client.runners.create.mutate({
      name: 'E2E Bob',
      runnerNumber: 'E2E-2',
      labels: [white.id],
    });
    const trojan = await client.labels.create.mutate({
      name: 'E2E Trojan',
      kind: 'temporary_team',
      color: '#7c3aed',
    });
    const trojanV2 = await client.labels.create.mutate({
      name: 'E2E Trojan V2',
      kind: 'temporary_team',
      color: '#db2777',
    });

    await client.temporaryTeams.setMembers.mutate({ labelId: trojan.id, runnerIds: [alice.id] });
    await client.temporaryTeams.setMembers.mutate({ labelId: trojanV2.id, runnerIds: [bob.id] });
    await assert.rejects(
      client.temporaryTeams.setMembers.mutate({ labelId: trojanV2.id, runnerIds: [alice.id] }),
      /maar in een tijdelijke nachtploeg/
    );

    await client.temporaryTeams.setActive.mutate({ labelId: trojan.id, active: true });
    await client.temporaryTeams.setActive.mutate({ labelId: trojanV2.id, active: true });
    await waitFor(() => realtimeTeams.some((teams) => teams.filter((team) => team.active).length === 2));

    let state = await fetchState(baseUrl);
    assert.deepEqual(currentTeamIds(state, alice.id), [trojan.id]);
    assert.deepEqual(currentTeamIds(state, bob.id), [trojanV2.id]);

    await client.runners.setStatus.mutate({ id: alice.id, status: 'waiting' });
    await client.race.startNext.mutate(raceExpectation(await fetchState(baseUrl)));
    await client.runners.setStatus.mutate({ id: bob.id, status: 'waiting' });
    await client.race.handoff.mutate(raceExpectation(await fetchState(baseUrl)));

    await client.temporaryTeams.setActive.mutate({ labelId: trojan.id, active: false });
    await client.runners.setStatus.mutate({ id: alice.id, status: 'waiting' });
    await client.race.handoff.mutate(raceExpectation(await fetchState(baseUrl)));

    await client.temporaryTeams.setActive.mutate({ labelId: trojanV2.id, active: false });
    await client.runners.setStatus.mutate({ id: bob.id, status: 'waiting' });
    await client.race.handoff.mutate(raceExpectation(await fetchState(baseUrl)));

    state = await fetchState(baseUrl);
    assert.deepEqual(currentTeamIds(state, alice.id), [blue.id]);
    assert.deepEqual(currentTeamIds(state, bob.id), [white.id]);
    assert.equal(filterLaps(state.laps, { enabledLabelIds: [trojan.id] }).length, 1);
    assert.equal(filterLaps(state.laps, { enabledLabelIds: [trojanV2.id] }).length, 1);
    assert.equal(filterLaps(state.laps, { enabledLabelIds: [blue.id] }).length, 1);

    const comparisons = buildLabelComparisons(
      [trojan, trojanV2, blue],
      state.laps
    );
    assert.deepEqual(
      Object.fromEntries(comparisons.map((comparison) => [comparison.label.name, comparison.count])),
      { 'Speedteam Blue': 1, 'E2E Trojan': 1, 'E2E Trojan V2': 1 }
    );

    const exportedJson = await fetch(`${baseUrl}/api/export/laps.json`).then((response) => response.json()) as {
      laps: AppSnapshot['laps'];
    };
    assert.equal(exportedJson.laps.filter((lap) => lap.labels.some((label) => label.id === trojan.id)).length, 1);
    const exportedCsv = await fetch(`${baseUrl}/api/export/laps.csv`).then((response) => response.text());
    assert.match(exportedCsv, /E2E Trojan/);
    assert.match(exportedCsv, /E2E Trojan V2/);

    const analysisPage = await fetch(`${baseUrl}/analysis`);
    assert.equal(analysisPage.status, 200);
    const analysisHtml = await analysisPage.text();
    assert.match(analysisHtml, /<div id="root"><\/div>/);
    const scriptPath = analysisHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
    assert.ok(scriptPath);
    const compressedAsset = await fetch(`${baseUrl}${scriptPath}`, {
      headers: { 'accept-encoding': 'br' },
    });
    assert.equal(compressedAsset.status, 200);
    assert.equal(compressedAsset.headers.get('content-encoding'), 'br');
    assert.match(compressedAsset.headers.get('content-type') || '', /^text\/javascript/);
    assert.match(compressedAsset.headers.get('cache-control') || '', /immutable/);

    socket.close();
    socket = null;
    await stopServer(server);
    server = null;

    ({ process: server, output: serverOutput } = await startServer(port));
    const restartedState = await fetchState(baseUrl);
    assert.equal(restartedState.laps.length, 3);
    assert.equal(restartedState.temporaryTeams.filter((team) => team.active).length, 0);
    assert.equal(filterLaps(restartedState.laps, { enabledLabelIds: [trojan.id] }).length, 1);
    assert.deepEqual(currentTeamIds(restartedState, alice.id), [blue.id]);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack || error.message : String(error)}\nServer output:\n${serverOutput}`);
  } finally {
    socket?.close();
    await stopServer(server);
    fs.rmSync(dataPath, { recursive: true, force: true });
  }

  async function startServer(serverPort: number): Promise<{ process: ChildProcess; output: string }> {
    const child = spawn(process.execPath, ['dist-server/server/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATA_PATH: dataPath,
        PORT: String(serverPort),
        PUBLIC_APP_PORT: String(serverPort),
        PUBLIC_HOST: '127.0.0.1',
        CLUSTER_ENABLED: 'false',
        APOLLOON_CLUSTER: 'false',
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    await waitFor(async () => {
      if (child.exitCode != null) throw new Error(`Server stopped with exit code ${child.exitCode}: ${output}`);
      try {
        return (await fetch(`${baseUrl}/api/state`)).ok;
      } catch {
        return false;
      }
    }, 10_000);
    serverOutput = output;
    return { process: child, output };
  }
});

function currentTeamIds(state: AppSnapshot, runnerId: string): string[] {
  return state.runners
    .find((runner) => runner.id === runnerId)?.labels
    .filter((label) => label.kind === 'speedteam' || label.kind === 'temporary_team')
    .map((label) => label.id) ?? [];
}

function raceExpectation(state: AppSnapshot) {
  return {
    activeRunnerId: state.race.activeRunnerId,
    activeStartedAt: state.race.activeStartedAt,
  };
}

async function fetchState(baseUrl: string): Promise<AppSnapshot> {
  const response = await fetch(`${baseUrl}/api/state`);
  assert.equal(response.status, 200);
  return response.json() as Promise<AppSnapshot>;
}

async function waitForSocket(socket: Socket): Promise<void> {
  if (socket.connected) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket.IO connection timed out')), 5_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition timed out');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function stopServer(server: ChildProcess | null): Promise<void> {
  if (!server || server.exitCode != null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => server.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (server.exitCode == null) server.kill('SIGKILL');
}
