import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { io, type Socket } from 'socket.io-client';
import type { AppRouter } from '../server/router.ts';
import type { AppSnapshot, LiveAppSnapshot, RaceHistory } from '../shared/schemas.ts';
import { buildLabelComparisons, filterLaps } from '../src/lib/analysis.ts';
import { temporaryDataPath } from './temporary-data.ts';

const dataPath = temporaryDataPath('temporary-teams-e2e');

test('night teams work through HTTP, realtime, analysis, exports, and a restart', { timeout: 45_000 }, async () => {
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

    const revisions: number[] = [];
    socket = io(baseUrl, { transports: ['websocket'], reconnection: false, autoConnect: false });
    socket.on('state:revision', (revision: number) => revisions.push(revision));
    socket.connect();
    await waitForSocket(socket);
    await waitFor(() => revisions.length > 0);
    const initialState = await fetchState(baseUrl);
    assert.equal(revisions.at(-1), initialState.revision);

    const labels = initialState.labels;
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

    const revisionBeforeActivation = revisions.at(-1) ?? 0;
    await client.temporaryTeams.setActive.mutate({ labelId: trojan.id, active: true });
    await client.temporaryTeams.setActive.mutate({ labelId: trojanV2.id, active: true });
    await waitFor(() => (revisions.at(-1) ?? 0) > revisionBeforeActivation);

    let state = await fetchState(baseUrl);
    assert.equal(state.temporaryTeams.filter((team) => team.active).length, 2);
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

    const liveResponse = await fetch(`${baseUrl}/api/state`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    const livePayload = (await liveResponse.json()) as LiveAppSnapshot & {
      laps?: unknown;
      events?: unknown;
    };
    assert.equal(liveResponse.headers.get('content-encoding'), 'gzip');
    assert.equal(livePayload.laps, undefined);
    assert.equal(livePayload.events, undefined);

    const historyResponse = await fetch(`${baseUrl}/api/history`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    const compressedHistory = (await historyResponse.json()) as RaceHistory;
    assert.equal(historyResponse.headers.get('content-encoding'), 'gzip');
    assert.equal(compressedHistory.laps.length, 3);
    const unchanged = await fetch(`${baseUrl}/api/history`, {
      headers: { 'if-none-match': historyResponse.headers.get('etag') ?? '' },
    });
    assert.equal(unchanged.status, 304);

    const runnerHistory = (await fetch(`${baseUrl}/api/history?runnerId=${encodeURIComponent(alice.id)}`).then(
      (response) => response.json()
    )) as RaceHistory;
    assert.equal(runnerHistory.scope, 'runner');
    assert.ok(runnerHistory.laps.every((lap) => lap.runnerId === alice.id));

    const comparisons = buildLabelComparisons([trojan, trojanV2, blue], state.laps);
    assert.deepEqual(Object.fromEntries(comparisons.map((comparison) => [comparison.label.name, comparison.count])), {
      'Speedteam Blue': 1,
      'E2E Trojan': 1,
      'E2E Trojan V2': 1,
    });

    const exportedJson = (await fetch(`${baseUrl}/api/export/laps.json`).then((response) => response.json())) as {
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
    const tacticsPage = await fetch(`${baseUrl}/tactics`);
    assert.equal(tacticsPage.status, 200);
    assert.match(await tacticsPage.text(), /<div id="root"><\/div>/);
    const scriptPath = analysisHtml.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
    assert.ok(scriptPath);
    const compressedAsset = await fetch(`${baseUrl}${scriptPath}`, {
      headers: { 'accept-encoding': 'br' },
    });
    assert.equal(compressedAsset.status, 200);
    assert.equal(compressedAsset.headers.get('content-encoding'), 'br');
    assert.match(compressedAsset.headers.get('content-type') || '', /^text\/javascript/);
    assert.match(compressedAsset.headers.get('cache-control') || '', /immutable/);

    const charlie = await client.runners.create.mutate({
      name: 'E2E Charlie',
      runnerNumber: 'E2E-3',
      labels: [blue.id],
    });
    const dana = await client.runners.create.mutate({ name: 'E2E Dana', runnerNumber: 'E2E-4', labels: [white.id] });
    const scheduledStart = Date.now() + 4_500;
    const scheduledEnd = scheduledStart + 2_000;
    const scheduled = await client.temporaryTeams.create.mutate({
      name: 'E2E Gepland',
      color: '#7c3aed',
      runnerIds: [charlie.id],
      startsAt: scheduledStart,
      endsAt: scheduledEnd,
    });
    assert.equal(scheduled.active, false);
    await assert.rejects(
      client.temporaryTeams.setActive.mutate({ labelId: scheduled.labelId, active: true }),
      /volgt haar planning/
    );

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
    assert.equal(
      restartedState.temporaryTeams.find((team) => team.labelId === scheduled.labelId)?.startsAt,
      scheduledStart
    );
    // The team starts on the clock, without any write; clients hear about it through a revision.
    socket = io(baseUrl, { transports: ['websocket'], reconnection: false });
    const revisionsAfterRestart: number[] = [];
    socket.on('state:revision', (revision: number) => revisionsAfterRestart.push(revision));
    await waitForSocket(socket);
    await waitFor(async () => currentTeamIds(await fetchState(baseUrl), charlie.id).includes(scheduled.labelId), 8_000);
    assert.ok(revisionsAfterRestart.length > 1);
    await waitFor(async () => currentTeamIds(await fetchState(baseUrl), charlie.id).includes(blue.id), 8_000);
    assert.equal(
      (await fetchState(baseUrl)).temporaryTeams.find((team) => team.labelId === scheduled.labelId)?.active,
      false
    );

    const immediate = await client.temporaryTeams.create.mutate({
      name: 'E2E Meteen',
      color: '#db2777',
      runnerIds: [dana.id],
      startsAt: Date.now() - 10 * 60_000,
      endsAt: Date.now() + 2_000,
    });
    assert.equal(immediate.active, true);
    assert.deepEqual(currentTeamIds(await fetchState(baseUrl), dana.id), [immediate.labelId]);
    await waitFor(async () => currentTeamIds(await fetchState(baseUrl), dana.id).includes(white.id), 8_000);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.stack || error.message : String(error)}\nServer output:\n${serverOutput}`,
      {
        cause: error,
      }
    );
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
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
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
  return (
    state.runners
      .find((runner) => runner.id === runnerId)
      ?.labels.filter((label) => label.kind === 'speedteam' || label.kind === 'temporary_team')
      .map((label) => label.id) ?? []
  );
}

function raceExpectation(state: AppSnapshot) {
  return {
    activeRunnerId: state.race.activeRunnerId,
    activeStartedAt: state.race.activeStartedAt,
  };
}

async function fetchState(baseUrl: string): Promise<AppSnapshot> {
  const [stateResponse, historyResponse] = await Promise.all([
    fetch(`${baseUrl}/api/state`),
    fetch(`${baseUrl}/api/history`),
  ]);
  assert.equal(stateResponse.status, 200);
  assert.equal(historyResponse.status, 200);
  const [state, history] = await Promise.all([
    stateResponse.json() as Promise<LiveAppSnapshot>,
    historyResponse.json() as Promise<RaceHistory>,
  ]);
  return { ...state, laps: history.laps, events: history.events };
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
      server.close((error) => (error ? reject(error) : resolve(port)));
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
