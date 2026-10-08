#!/usr/bin/env node
/*
 * A rehearsal of the event: three servers form a group, a bot presses Space
 * on the timing laptop and a desk bot puts runners back in the queue, while
 * laptops lose power, lose their cable, or fall asleep (lid closed) at
 * random. Afterwards everything comes back and the lap log must be identical
 * on every laptop, with every confirmed lap exactly once.
 *
 *   npm run rehearse                     three minutes of chaos on this machine
 *   npm run rehearse -- --minutes=10     longer
 *   npm run rehearse -- --seed=1234      the same fault schedule again
 *   npm run rehearse -- --keep           keep data and server logs
 *
 * With --hardware the same runs on the three real laptops with the installed
 * app, over SSH; see docs/rehearse-hardware.md and scripts/rehearse-hardware.mjs.
 *
 *   npm run rehearse -- --hardware                 laptops from rehearse-laptops.json
 *   npm run rehearse -- --hardware=other.json      another list
 *   npm run rehearse -- --hardware --hands         also asks a person to pull real cables and lids
 *   npm run rehearse -- --hardware --link          link laptops that are not in one group yet
 *   npm run rehearse -- --hardware --keep          keep the rehearsal laps instead of restoring
 *   npm run rehearse -- --hardware --heal          only remove firewall rules and start the apps
 *
 * Uses the production timings (heartbeat, election and commit timeouts), so
 * a press may wait through a takeover exactly as it would at the event.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hardwareLaptops } from './rehearse-hardware.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? 'true'];
  })
);
const hardware = args.hardware
  ? path.resolve(args.hardware === 'true' ? 'rehearse-laptops.json' : args.hardware)
  : null;
const minutes = Number(args.minutes || (hardware ? 15 : 3));
const seed = Number(args.seed || Math.floor(Math.random() * 1e9));
const keep = args.keep === 'true';
const hands = args.hands === 'true';
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
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

const stats = { presses: 0, laps: 0, conflicts: 0, emptyQueue: 0, notSaved: 0, lost: 0, faults: 0 };
/** Laps the timing screen was told are saved. */
const confirmedLaps = new Set();
/** Errors a screen should never show while at most one laptop is gone. */
const problems = [];

/** The first Ctrl+C ends the chaos early and checks; faults end their hold at once. */
const stopChaos = new AbortController();
function hold(ms) {
  return new Promise((resolve) => {
    if (stopChaos.signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      stopChaos.signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    stopChaos.signal.addEventListener('abort', done);
  });
}

// Servers on this machine.

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
      CLUSTER_AUTO_LINK: 'false',
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

async function setIsolated(laptop, isolated) {
  await fetch(`${laptop.url}/api/cluster/test/isolate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolated }),
  });
}

/** Three servers on this machine; a pulled cable is the server's own test switch. */
async function localLaptops() {
  fs.rmSync(root, { recursive: true, force: true });
  const laptops = [];
  for (const name of ['timing', 'desk', 'warmup']) {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    laptops.push({
      name,
      port,
      url,
      lanUrl: url,
      dataPath: path.join(root, name),
      logPath: path.join(root, `${name}.log`),
      state: 'off',
      child: null,
    });
  }
  const driver = {
    laptops,
    faults: ['power', 'power', 'cable', 'cable', ...(canSleep ? ['lid'] : [])],
    durations: { power: [1_000, 10_000], cable: [1_000, 10_000], lid: [500, 6_000] },
    async powerOff(laptop) {
      laptop.child?.kill('SIGKILL');
      laptop.state = 'off';
    },
    async powerOn(laptop) {
      if (laptop.state === 'off') launch(laptop);
      await waitUntilUp(laptop);
    },
    cut: (laptop) => setIsolated(laptop, true),
    reconnect: (laptop) => setIsolated(laptop, false),
    async freeze(laptop) {
      laptop.child.kill('SIGSTOP');
      laptop.state = 'asleep';
    },
    async thaw(laptop) {
      laptop.child.kill('SIGCONT');
      laptop.state = 'up';
    },
    async heal() {
      for (const laptop of laptops) {
        if (laptop.state === 'asleep') await driver.thaw(laptop);
        if (laptop.state === 'off') await driver.powerOn(laptop);
        await driver.reconnect(laptop);
      }
      return [];
    },
    async close() {
      for (const laptop of laptops) {
        if (laptop.state === 'asleep') laptop.child?.kill('SIGCONT');
        laptop.child?.kill('SIGKILL');
      }
      await sleep(200);
    },
  };
  return driver;
}

async function startLocalGroup({ laptops }) {
  for (const laptop of laptops) {
    launch(laptop);
    await waitUntilUp(laptop);
  }
  await linkGroup(laptops);
  await waitFor(async () => (await get(laptops[0], '/api/cluster/status')).state === 'healthy', 20_000);
  await addRunners(laptops[1], 'Loper', 'R');
  say('three laptops linked, eight runners waiting');
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
    body: input === undefined ? undefined : JSON.stringify(input),
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

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await sleep(100);
  }
  throw new Error('timed out');
}

/** The others join the first laptop's group. */
async function linkGroup(laptops) {
  for (const laptop of laptops.slice(1)) {
    await waitFor(async () => Boolean((await get(laptops[0], '/api/cluster/status')).leader), 15_000);
    const joined = await mutate(laptop, 'cluster.join', { url: laptops[0].lanUrl });
    if (joined.error) throw new Error(`${laptop.name} could not join: ${joined.error.message}`);
  }
}

/** Eight runners waiting in the queue; on real laptops, the ones a stopped rehearsal left are used again. */
async function addRunners(laptop, name, prefix) {
  const { runners } = await get(laptop, '/api/state');
  const numbers = new Set(runners.map((runner) => runner.runnerNumber));
  for (let index = 1; index <= 8; index += 1) {
    if (numbers.has(`${prefix}-${index}`)) continue;
    const created = await mutate(laptop, 'runners.create', {
      name: `${name} ${index}`,
      runnerNumber: `${prefix}-${index}`,
      status: 'waiting',
    });
    if (created.error) throw new Error(`creating runners failed: ${created.error.message}`);
  }
}

// The real laptops.

async function groupCounts(laptop) {
  const [{ runners }, { laps }] = await Promise.all([get(laptop, '/api/state'), get(laptop, '/api/history')]);
  return { runners: runners.length, laps: laps.length };
}

/** Checks the three laptops form one group, then saves a backup to put back afterwards. */
async function prepareHardware(driver) {
  const { laptops } = driver;
  say(`checking ${laptops.map((laptop) => `${laptop.name} (${laptop.ip})`).join(', ')}`);
  await driver.preflight();
  const leftovers = await driver.heal();
  if (leftovers.length) throw new Error(leftovers.join('; '));

  const statuses = () => Promise.all(laptops.map((laptop) => get(laptop, '/api/cluster/status')));
  const before = await statuses();
  if (new Set(before.map((status) => status.appVersion)).size > 1) {
    throw new Error(
      `the laptops run different versions: ${laptops.map((laptop, index) => `${laptop.name} ${before[index].appVersion}`).join(', ')}`
    );
  }
  const hostIds = new Set(before.map((status) => status.hostId));
  if (hostIds.size !== laptops.length) throw new Error('two entries in the laptop list reach the same laptop');
  const linked = (list) =>
    list.every(
      (status) =>
        status.clusterId === list[0].clusterId &&
        status.members.length === laptops.length &&
        status.members.every((member) => hostIds.has(member.hostId))
    );
  if (!linked(before)) {
    if (args.link !== 'true') {
      throw new Error(
        'these three laptops are not one group. Link them in Beheer › Systeem › Laptops koppelen, ' +
          'or pass --link (the joining laptops keep their own data in a backup).'
      );
    }
    say(
      `linking ${laptops
        .slice(1)
        .map((laptop) => laptop.name)
        .join(' and ')} to ${laptops[0].name}`
    );
    await linkGroup(laptops);
    await waitFor(async () => linked(await statuses()), 20_000).catch(() => {
      throw new Error('linking the laptops did not give one group of three');
    });
  }
  const healthy = await waitFor(async () => (await statuses()).every((status) => status.state === 'healthy'), 60_000)
    .then(() => true)
    .catch(() => false);
  if (!healthy) throw new Error('the group is not "healthy" on every laptop; check Beheer › Systeem');

  const backup = await mutate(laptops[0], 'backups.create');
  if (backup.error) throw new Error(`the backup before the rehearsal failed: ${backup.error.message}`);
  const counts = await groupCounts(laptops[0]);
  say(`saved ${backup.data.fileName} on ${laptops[0].name}: ${counts.runners} runners, ${counts.laps} laps`);
  await addRunners(laptops[0], 'Oefenloper', 'OEFEN');
  say(`three laptops linked (${before[0].appVersion}), eight practice runners waiting`);
  return { fileName: backup.data.fileName, counts };
}

/** Puts every laptop back to the backup from before the rehearsal. */
async function restoreHardware({ laptops }, backup) {
  say(`putting back ${backup.fileName}`);
  const restored = await mutate(laptops[0], 'backups.restore', { fileName: backup.fileName });
  if (restored.error) throw new Error(restored.error.message);
  const same = await waitFor(async () => {
    const counts = await Promise.all(laptops.map(groupCounts));
    return counts.every((count) => count.runners === backup.counts.runners && count.laps === backup.counts.laps);
  }, 30_000)
    .then(() => true)
    .catch(() => false);
  if (!same)
    throw new Error(`not every laptop is back to ${backup.counts.runners} runners and ${backup.counts.laps} laps`);
  say(`every laptop is back to ${backup.counts.runners} runners and ${backup.counts.laps} laps`);
}

// A person at the laptops, for what no command can do: a real cable, a real lid, a real power button.

let terminal = null;
function ask(question) {
  terminal ??= readline.createInterface({ input: process.stdin });
  console.log(`\n>>> ${question}\n>>> Press Enter when done.\n`);
  return new Promise((resolve) => terminal.once('line', resolve));
}

async function byHand(driver, laptop, durationMs) {
  // The laptop running this rehearsal must stay on.
  const kind = pick(laptop.ssh ? ['cable', 'cable', 'lid', 'power'] : ['cable']);
  if (kind === 'cable') {
    await ask(`Pull the network cable of ${laptop.name}.`);
    say(`${laptop.name}: real cable out for ${seconds(durationMs)}`);
    await hold(durationMs);
    await ask(`Plug the network cable of ${laptop.name} back in.`);
    say(`${laptop.name}: real cable back`);
    return;
  }
  if (kind === 'lid') {
    await ask(`Close the lid of ${laptop.name} and wait until it sleeps.`);
    laptop.state = 'asleep';
    say(`${laptop.name}: real lid closed for ${seconds(durationMs)}`);
    await hold(durationMs);
    await ask(`Open the lid of ${laptop.name} and log in if it asks.`);
  } else {
    await ask(`Switch ${laptop.name} off: hold its power button until the screen goes dark.`);
    laptop.state = 'off';
    say(`${laptop.name}: switched off for ${seconds(durationMs)}`);
    await hold(durationMs);
    await ask(`Switch ${laptop.name} on, log in and start Apolloon.`);
  }
  await waitFor(() => driver.answers(laptop), 10 * 60_000);
  laptop.state = 'up';
  say(`${laptop.name}: back`);
}

// Chaos: power cuts, pulled cables, closed lids. Mostly one laptop at a time, sometimes two.

async function chaos(driver, until) {
  const { laptops } = driver;
  const active = new Set();
  const pending = [];
  let byHandRunning = false;
  /** A person gets a few minutes between requests. */
  let byHandAllowedAt = 0;
  while (Date.now() < until && !stopChaos.signal.aborted) {
    await hold(between(1_000, 4_000));
    if (byHandRunning || stopChaos.signal.aborted) continue;
    if (active.size >= 2 || (active.size === 1 && random() > 0.15)) continue;
    const free = laptops.filter((candidate) => !active.has(candidate));
    const laptop = pick(free);
    let fault = pick(driver.faults);
    // A person handles one laptop at a time, with nothing else going on.
    if (fault === 'hands' && (active.size || Date.now() < byHandAllowedAt)) continue;
    const partner = fault === 'split' ? pick(free.filter((candidate) => candidate !== laptop)) : null;
    if (fault === 'split' && !partner) fault = 'cable';
    const durationMs = between(...driver.durations[fault]);
    active.add(laptop);
    if (partner) active.add(partner);
    if (fault === 'hands') byHandRunning = true;
    stats.faults += 1;
    pending.push(
      (async () => {
        if (fault === 'power') {
          say(`${laptop.name}: power cut for ${seconds(durationMs)}`);
          await driver.powerOff(laptop);
          await hold(durationMs);
          await driver.powerOn(laptop);
          say(`${laptop.name}: back on`);
        } else if (fault === 'cable') {
          say(`${laptop.name}: cable pulled for ${seconds(durationMs)}`);
          await driver.cut(
            laptop,
            laptops.filter((other) => other !== laptop)
          );
          // Alone, a laptop stops saving within about two seconds. If it does not, the cut did not happen.
          const check =
            durationMs >= 6_000
              ? waitFor(async () => (await get(laptop, '/api/cluster/status')).writable === false, 5_000).catch(() =>
                  problems.push(`${elapsed()} ${laptop.name} still saved with its cable pulled: the cut did not take`)
                )
              : null;
          await hold(durationMs);
          await check;
          await driver.reconnect(laptop);
          say(`${laptop.name}: cable back`);
        } else if (fault === 'split') {
          say(`${laptop.name} and ${partner.name}: cannot reach each other for ${seconds(durationMs)}`);
          await driver.cut(laptop, [partner]);
          await hold(durationMs);
          await driver.reconnect(laptop);
          say(`${laptop.name} and ${partner.name}: reach each other again`);
        } else if (fault === 'lid') {
          say(`${laptop.name}: lid closed for ${seconds(durationMs)}`);
          await driver.freeze(laptop);
          await hold(durationMs);
          await driver.thaw(laptop);
          say(`${laptop.name}: lid open`);
        } else {
          await byHand(driver, laptop, durationMs);
        }
        active.delete(laptop);
        if (partner) active.delete(partner);
      })()
        .catch((error) => problems.push(`${elapsed()} ${fault} on ${laptop.name}: ${error.message}`))
        .finally(() => {
          if (fault !== 'hands') return;
          byHandRunning = false;
          byHandAllowedAt = Date.now() + 120_000;
        })
    );
  }
  await Promise.all(pending);
}

// The timing screen: one press at a time, with the race state it shows.

async function press(laptop) {
  const { race } = await get(laptop, '/api/state');
  // Dated on the group clock, as the timing screen does from its key event.
  const askedAt = Date.now();
  const { serverNowMs } = await get(laptop, '/api/time');
  const pressedAt = Math.round(serverNowMs + (Date.now() - askedAt) / 2);
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
function timingScreen(laptops) {
  const usable = (laptop) => laptop.state === 'up';
  return usable(laptops[0]) ? laptops[0] : pick(laptops.filter(usable));
}

async function timingBot(laptops, isRunning) {
  while (isRunning()) {
    await sleep(between(300, 1_500));
    const laptop = timingScreen(laptops);
    if (!laptop) continue;
    await press(laptop).catch(() => {
      stats.lost += 1;
    });
  }
}

async function deskBot(laptops, isRunning) {
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

async function verify(driver) {
  const { laptops } = driver;
  say('healing: every laptop back on, cables in, lids open');
  problems.push(...(await driver.heal()));
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

  const [laps = []] = logs;
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
  if (hands && !process.stdin.isTTY) throw new Error('--hands asks a person to act, so run it in a terminal');
  const driver = hardware ? await hardwareLaptops(hardware) : await localLaptops();
  const { laptops } = driver;
  if (hardware) {
    driver.faults = ['power', 'power', 'cable', 'cable', 'split', 'lid', ...(hands ? ['hands', 'hands'] : [])];
    driver.durations = {
      power: [3_000, 15_000],
      cable: [2_000, 15_000],
      split: [3_000, 15_000],
      lid: [1_000, 8_000],
      hands: [10_000, 30_000],
    };
  }

  // A second Ctrl+C stops at once, but never leaves a laptop cut off or frozen.
  process.on('SIGINT', () => {
    if (!stopChaos.signal.aborted) {
      console.log('\nStopping the chaos; healing and checking. Ctrl+C again to stop at once.');
      stopChaos.abort();
      return;
    }
    console.log('\nStopping at once.');
    void (hardware ? driver.heal() : Promise.resolve()).finally(() => driver.close()).finally(() => process.exit(130));
  });

  if (args.heal === 'true') {
    const failures = await driver.heal();
    await driver.close();
    if (failures.length) {
      console.error(`Not healed:\n- ${failures.join('\n- ')}`);
      process.exit(1);
    }
    console.log('Every laptop runs Apolloon, without rehearsal firewall rules or frozen processes.');
    return;
  }

  const where = hardware ? `on ${laptops.map((laptop) => laptop.name).join(', ')}` : 'on this machine';
  console.log(
    `Rehearsal ${where}: ${minutes} min of chaos, seed ${seed} (replay the fault schedule with --seed=${seed})`
  );
  let running = true;
  let backup = null;
  try {
    if (hardware) backup = await prepareHardware(driver);
    else await startLocalGroup(driver);
    const bots = [timingBot(laptops, () => running), deskBot(laptops, () => running)];
    await chaos(driver, Date.now() + minutes * 60_000);
    running = false;
    await Promise.all(bots);
    const stored = await verify(driver);
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
    terminal?.close();
  }

  if (hardware && problems.length) await driver.saveLogs(root).catch(() => undefined);
  if (hardware && backup) {
    if (problems.length) {
      console.error(
        `\nThe rehearsal laps are still on the laptops, to look into. To put back the data from before, open ` +
          `Beheer › Systeem & herstel › Backup terugzetten on ${laptops[0].name} and restore ${backup.fileName}.`
      );
    } else if (keep) {
      console.log(`\nKept the rehearsal laps. The data from before is ${backup.fileName} on ${laptops[0].name}.`);
    } else {
      await restoreHardware(driver, backup).catch((error) =>
        problems.push(
          `putting back ${backup.fileName} failed (${error.message}); restore it in Beheer › Systeem & herstel on ${laptops[0].name}`
        )
      );
    }
  }
  await driver.close();

  if (problems.length) {
    const logs = hardware ? `Last lines of each laptop's server log: ${root}` : `Server logs: ${root}`;
    console.error(`\nREHEARSAL FAILED (seed ${seed}):\n- ${problems.join('\n- ')}\n${logs}`);
    process.exit(1);
  }
  console.log('Every laptop holds the same laps, and every confirmed lap exactly once.');
  if (!keep && !hardware) fs.rmSync(root, { recursive: true, force: true });
}

await main();
