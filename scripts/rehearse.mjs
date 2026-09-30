#!/usr/bin/env node
/*
 * A rehearsal of the event on one machine: three real servers form a group,
 * a bot presses Space on the timing laptop and a desk bot puts runners back
 * in the queue, while laptops lose power, lose their cable, or fall asleep
 * (lid closed) at random. Afterwards everything comes back and the lap log
 * must be identical on every laptop, with every confirmed lap exactly once.
 *
 *   npm run rehearse                     three minutes of chaos
 *   npm run rehearse -- --minutes=10     longer
 *   npm run rehearse -- --seed=1234      the same fault schedule again
 *   npm run rehearse -- --keep           keep data and server logs
 *
 * Uses the production timings (heartbeat, election and commit timeouts), so
 * a press may wait through a takeover exactly as it would at the event.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? 'true'];
  })
);
const minutes = Number(args.minutes || 3);
const seed = Number(args.seed || Math.floor(Math.random() * 1e9));
const keep = args.keep === 'true';
const root = path.join(repoRoot, '.rehearse');
const discoveryPort = 20_000 + (process.pid % 20_000);
const canSleep = process.platform !== 'win32';

let randomState = seed >>> 0;
function random() {
  randomState = (randomState + 0x6d2b79f5) >>> 0;
  let t = randomState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
}
const between = (min, max) => min + random() * (max - min);
const pick = (items) => items[Math.floor(random() * items.length)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now();
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)}s`;
const say = (line) => console.log(`${elapsed()}  ${line}`);

const stats = { presses: 0, laps: 0, conflicts: 0, emptyQueue: 0, notSaved: 0, lost: 0, faults: 0 };
/** Laps the timing screen was told are saved. */
const confirmedLaps = new Set();
/** Errors a screen should never show while at most one laptop is gone. */
const problems = [];

// Servers.

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function launch(laptop) {
  fs.mkdirSync(laptop.dataPath, { recursive: true });
  const logFile = fs.openSync(laptop.logPath, 'a');
  laptop.child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(laptop.port),
      PUBLIC_APP_PORT: String(laptop.port),
      DATA_PATH: laptop.dataPath,
      CLUSTER_ENABLED: 'true',
      CLUSTER_SELF_URL: laptop.url,
      CLUSTER_TEST_FAULTS: 'true',
      CLUSTER_DISCOVERY_ADDRESS: '127.255.255.255',
      CLUSTER_DISCOVERY_PORT: String(discoveryPort),
      BACKUP_ENABLED: 'false',
      APOLLOON_APP_VERSION: '0.0.0-rehearse',
    },
    stdio: ['ignore', logFile, logFile],
  });
  laptop.state = 'up';
}

async function waitUntilUp(laptop) {
  await waitFor(async () => (await fetch(`${laptop.url}/api/host-info`).catch(() => null))?.ok === true, 30_000);
}

function kill(laptop) {
  laptop.child?.kill('SIGKILL');
  laptop.state = 'off';
}

async function stopAll() {
  for (const laptop of laptops) {
    if (laptop.state === 'asleep') laptop.child?.kill('SIGCONT');
    laptop.child?.kill('SIGKILL');
  }
  await sleep(200);
}

// Talking to a laptop like its screens do.

async function get(laptop, route) {
  const response = await fetch(`${laptop.url}${route}`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
}

/** A tRPC mutation; resolves with its data or { error: { code, message } }. */
async function mutate(laptop, procedure, input) {
  const response = await fetch(`${laptop.url}/trpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? null),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (payload?.result) return { data: payload.result.data };
  return {
    error: {
      code: payload?.error?.data?.code ?? `HTTP ${response.status}`,
      message: payload?.error?.message ?? JSON.stringify(payload),
    },
  };
}

async function setIsolated(laptop, isolated) {
  await fetch(`${laptop.url}/api/cluster/test/isolate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolated }),
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await sleep(100);
  }
  throw new Error('timed out');
}

// The group.

/** Filled as they start, so they are stopped even when starting fails. */
const laptops = [];

async function startGroup() {
  fs.rmSync(root, { recursive: true, force: true });
  for (const name of ['timing', 'desk', 'warmup']) {
    const port = await freePort();
    laptops.push({
      name,
      port,
      url: `http://127.0.0.1:${port}`,
      dataPath: path.join(root, name),
      logPath: path.join(root, `${name}.log`),
      state: 'off',
      child: null,
    });
  }
  for (const laptop of laptops) {
    launch(laptop);
    await waitUntilUp(laptop);
  }
  for (const laptop of laptops.slice(1)) {
    await waitFor(async () => Boolean((await get(laptops[0], '/api/cluster/status')).leader), 15_000);
    const joined = await mutate(laptop, 'cluster.join', { url: laptops[0].url });
    if (joined.error) throw new Error(`${laptop.name} could not join: ${joined.error.message}`);
  }
  await waitFor(async () => (await get(laptops[0], '/api/cluster/status')).state === 'healthy', 20_000);
  for (let index = 1; index <= 8; index += 1) {
    const created = await mutate(laptops[1], 'runners.create', {
      name: `Loper ${index}`,
      runnerNumber: `R-${index}`,
      status: 'waiting',
    });
    if (created.error) throw new Error(`creating runners failed: ${created.error.message}`);
  }
  say('three laptops linked, eight runners waiting');
}

// Chaos: power cuts, pulled cables, closed lids. Mostly one laptop at a time, sometimes two.

async function chaos(until) {
  const active = new Set();
  const pending = [];
  while (Date.now() < until) {
    await sleep(between(1_000, 4_000));
    if (active.size >= 2 || (active.size === 1 && random() > 0.15)) continue;
    const laptop = pick(laptops.filter((candidate) => !active.has(candidate)));
    const faults = ['power', 'power', 'cable', 'cable', ...(canSleep ? ['lid'] : [])];
    const fault = pick(faults);
    const durationMs = fault === 'lid' ? between(500, 6_000) : between(1_000, 10_000);
    active.add(laptop);
    stats.faults += 1;
    pending.push(
      (async () => {
        if (fault === 'power') {
          say(`${laptop.name}: power cut for ${(durationMs / 1000).toFixed(1)} s`);
          kill(laptop);
          await sleep(durationMs);
          launch(laptop);
          await waitUntilUp(laptop);
          say(`${laptop.name}: back on`);
        } else if (fault === 'cable') {
          say(`${laptop.name}: cable pulled for ${(durationMs / 1000).toFixed(1)} s`);
          await setIsolated(laptop, true);
          await sleep(durationMs);
          await setIsolated(laptop, false);
          say(`${laptop.name}: cable back`);
        } else {
          say(`${laptop.name}: lid closed for ${(durationMs / 1000).toFixed(1)} s`);
          laptop.child.kill('SIGSTOP');
          laptop.state = 'asleep';
          await sleep(durationMs);
          laptop.child.kill('SIGCONT');
          laptop.state = 'up';
          say(`${laptop.name}: lid open`);
        }
        active.delete(laptop);
      })().catch((error) => problems.push(`fault on ${laptop.name}: ${error.message}`))
    );
  }
  await Promise.all(pending);
}

// The timing screen: one press at a time, with the race state it shows.

async function press(laptop) {
  const { race } = await get(laptop, '/api/state');
  const pressedAt = Date.now();
  const input = { activeRunnerId: race.activeRunnerId, activeStartedAt: race.activeStartedAt, pressedAt };
  stats.presses += 1;
  let outcome;
  try {
    outcome = await mutate(laptop, race.activeRunnerId ? 'race.handoff' : 'race.startNext', input);
  } catch {
    // The laptop went away mid-press: nobody knows whether it counted, like a screen that went dark.
    stats.lost += 1;
    return null;
  }
  if (outcome.data) {
    if (outcome.data.lapId) {
      confirmedLaps.add(outcome.data.lapId);
      stats.laps += 1;
    }
    return outcome.data;
  }
  classify(laptop, 'Space', outcome.error);
  return null;
}

function classify(laptop, action, error) {
  if (error.code === 'CONFLICT' && /wachtrij/.test(error.message)) stats.emptyQueue += 1;
  else if (error.code === 'CONFLICT') {
    stats.conflicts += 1;
    say(`${laptop.name}: ${action} refused, the screen was behind`);
  } else if (error.code === 'SERVICE_UNAVAILABLE') stats.notSaved += 1;
  else {
    problems.push(`${elapsed()} ${action} on ${laptop.name}: ${error.code} ${error.message}`);
    say(`!! ${action} on ${laptop.name}: ${error.code} ${error.message}`);
  }
}

/** The operator sits at the timing laptop, and moves to another when its screen goes dark. */
function timingScreen() {
  const usable = (laptop) => laptop.state === 'up';
  return usable(laptops[0]) ? laptops[0] : pick(laptops.filter(usable));
}

async function timingBot(isRunning) {
  while (isRunning()) {
    await sleep(between(300, 1_500));
    const laptop = timingScreen();
    if (!laptop) continue;
    await press(laptop).catch(() => {
      stats.lost += 1;
    });
  }
}

async function deskBot(isRunning) {
  while (isRunning()) {
    await sleep(between(500, 2_000));
    const laptop = pick(laptops.filter((candidate) => candidate.state === 'up'));
    if (!laptop) continue;
    try {
      const { runners } = await get(laptop, '/api/state');
      for (const runner of runners.filter((candidate) => candidate.status === 'ran').slice(0, 3)) {
        const outcome = await mutate(laptop, 'runners.setStatus', { id: runner.id, status: 'waiting' });
        if (outcome.error) classify(laptop, 'queue', outcome.error);
      }
    } catch {
      // The laptop went away mid-request.
    }
  }
}

// The verdict.

async function lapLog(laptop) {
  const history = await get(laptop, '/api/history');
  return history.laps
    .map(({ id, runnerId, lapNumber, startedAt, finishedAt, durationMs }) => ({
      id,
      runnerId,
      lapNumber,
      startedAt,
      finishedAt,
      durationMs,
    }))
    .sort((a, b) => a.finishedAt - b.finishedAt || a.id.localeCompare(b.id));
}

async function verify() {
  say('healing: every laptop back on, cables in, lids open');
  for (const laptop of laptops) {
    if (laptop.state === 'off') {
      launch(laptop);
      await waitUntilUp(laptop);
    }
    await setIsolated(laptop, false);
  }
  const healthy = await waitFor(
    async () =>
      (await Promise.all(laptops.map((laptop) => get(laptop, '/api/cluster/status')))).every(
        (status) => status.state === 'healthy'
      ),
    60_000
  )
    .then(() => true)
    .catch(() => false);
  if (!healthy) problems.push('the group did not report "healthy" on every laptop within 60 s after healing');

  // One more press must go through once everything is back.
  const final = await press(laptops[0]);
  if (!final) problems.push('a press after healing was not saved');

  let logs = [];
  const same = await waitFor(async () => {
    logs = await Promise.all(laptops.map(lapLog));
    return logs.every((log) => JSON.stringify(log) === JSON.stringify(logs[0]));
  }, 30_000)
    .then(() => true)
    .catch(() => false);
  if (!same) {
    problems.push(
      `the lap logs differ: ${logs.map((log, index) => `${laptops[index].name} ${log.length}`).join(', ')}`
    );
  }

  const [laps] = logs;
  const ids = new Set(laps.map((lap) => lap.id));
  if (ids.size !== laps.length) problems.push('a lap is stored twice');
  for (const lapId of confirmedLaps) if (!ids.has(lapId)) problems.push(`confirmed lap ${lapId} is missing`);
  for (let index = 1; index < laps.length; index += 1) {
    if (laps[index].startedAt < laps[index - 1].finishedAt) {
      problems.push(`laps ${laps[index - 1].id} and ${laps[index].id} overlap: two runners were counted at once`);
    }
  }
  const perRunner = new Map();
  for (const lap of laps) perRunner.set(lap.runnerId, [...(perRunner.get(lap.runnerId) ?? []), lap.lapNumber]);
  for (const [runnerId, numbers] of perRunner) {
    const expected = numbers.map((_, index) => index + 1);
    if (JSON.stringify([...numbers].sort((a, b) => a - b)) !== JSON.stringify(expected)) {
      problems.push(`runner ${runnerId} has lap numbers ${numbers.join(', ')}`);
    }
  }
  return laps.length;
}

async function main() {
  console.log(`Rehearsal: ${minutes} min of chaos, seed ${seed} (replay the fault schedule with --seed=${seed})`);
  let running = true;
  try {
    await startGroup();
    const bots = [timingBot(() => running), deskBot(() => running)];
    await chaos(Date.now() + minutes * 60_000);
    running = false;
    await Promise.all(bots);
    const stored = await verify();
    console.log(
      `\n${stats.presses} presses: ${stats.laps} laps confirmed, ${stats.conflicts} refused as stale, ` +
        `${stats.emptyQueue} on an empty queue, ${stats.notSaved} not saved, ${stats.lost} cut off mid-press. ` +
        `${stats.faults} faults. ` +
        `${stored} laps stored on every laptop.`
    );
  } catch (error) {
    problems.push(error instanceof Error ? error.stack || error.message : String(error));
  } finally {
    running = false;
    await stopAll();
  }
  if (problems.length) {
    console.error(`\nREHEARSAL FAILED (seed ${seed}):\n- ${problems.join('\n- ')}\nServer logs: ${root}`);
    process.exit(1);
  }
  console.log('Every laptop holds the same laps, and every confirmed lap exactly once.');
  if (!keep) fs.rmSync(root, { recursive: true, force: true });
}

await main();
