#!/usr/bin/env node
// Starts, checks, and stops throwaway Apolloon servers for verification.
//   verify.mjs up [--run=NAME] [--scenario=ready|empty|live|large] [--laptops=1|3] [--port=N] [--evidence-dir=DIR]
//   verify.mjs doctor [--run=NAME]
//   verify.mjs electron [--run=NAME]   (desktop window, headless, for a run started with --port=5173)
//   verify.mjs down [--run=NAME]
//   verify.mjs list
// Scratch data lives in .tmp-verify/<run>/ and is removed by `down`.
// Evidence lives in .tmp-verify-evidence/<run>/ (or --evidence-dir) and is never removed by this script.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))), '../../../..');
const scratchRoot = path.join(repoRoot, '.tmp-verify');
const evidenceRoot = path.join(repoRoot, '.tmp-verify-evidence');
const serverEntry = path.join(repoRoot, 'dist-server/server/index.js');
const clientEntry = path.join(repoRoot, 'dist/index.html');

const [command, ...rest] = process.argv.slice(2);
const options = Object.fromEntries(
  rest.map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  })
);

const commands = { up, doctor, electron, down, list };
if (!commands[command]) {
  console.error(
    'Usage: verify.mjs <up|doctor|electron|down|list> [--run=NAME] [--scenario=ready] [--laptops=1|3] [--port=N] [--evidence-dir=DIR]'
  );
  process.exit(2);
}
process.exitCode = (await commands[command]()) ?? 0;

async function up() {
  const run = options.run || `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`;
  const scenario = options.scenario || 'ready';
  const laptopCount = Number(options.laptops || 1);
  if (![1, 3].includes(laptopCount)) return fail('--laptops must be 1 or 3');
  if (options.port && laptopCount !== 1) return fail('--port only works with one laptop');
  const existing = readState(run, { quiet: true });
  if (existing?.laptops.some((laptop) => alive(laptop.pid))) {
    return fail(`Run ${run} is still up. Use it, or stop it with: verify.mjs down --run=${run}`);
  }
  const stale = staleBuild();
  if (stale) return fail(`${stale}\nRun \`npm run build\` first (about 3 s).`);

  const runDir = path.join(scratchRoot, run);
  // ship-pr points this outside the checkout, so PR screenshots never sit in the repo.
  const evidenceDir = options['evidence-dir'] ? path.resolve(options['evidence-dir']) : path.join(evidenceRoot, run);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  const discoveryPort = 20_000 + (process.pid % 20_000);
  const laptops = [];
  for (let index = 0; index < laptopCount; index++) {
    const dataPath = path.join(runDir, `laptop-${index}`);
    // Like `npm run test:ui`: in a group only the first laptop gets data; the others link to it.
    if (index === 0) {
      execFileSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/seed-test-db.mjs', `--scenario=${scenario}`, `--data-path=${dataPath}`],
        { cwd: repoRoot, stdio: 'ignore' }
      );
    } else {
      fs.mkdirSync(dataPath, { recursive: true });
    }
    const port = Number(options.port) || (await freePort());
    if (!(await portFree(port))) return fail(`Port ${port} is already in use`);
    const url = `http://127.0.0.1:${port}`;
    const log = path.join(runDir, `laptop-${index}.log`);
    const logFd = fs.openSync(log, 'a');
    // detached: own process group, so `down` can stop it and the agent's shell ending does not.
    const child = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DATA_PATH: dataPath,
        PORT: String(port),
        CLUSTER_ENABLED: laptopCount > 1 ? 'true' : 'false',
        CLUSTER_SELF_URL: url,
        CLUSTER_DISCOVERY_ADDRESS: '127.255.255.255',
        CLUSTER_DISCOVERY_PORT: String(discoveryPort),
        // Every laptop of a run shares this machine's name; give each its own, as at the event.
        CLUSTER_LAPTOP_NAME: `LAPTOP-${index}`,
        BACKUP_ENABLED: 'false',
        APOLLOON_UPDATE_CHECK: '0',
      },
    });
    child.unref();
    laptops.push({ index, url, port, pid: child.pid, dataPath, log });
  }
  const state = {
    run,
    scenario,
    startedAt: new Date().toISOString(),
    commit: git('rev-parse', 'HEAD'),
    discoveryPort,
    laptops,
    evidenceDir,
  };
  fs.writeFileSync(path.join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  for (const laptop of laptops) {
    if (!(await waitForServer(laptop))) {
      return fail(
        `Laptop ${laptop.index} at ${laptop.url} did not start. Log: ${laptop.log}\nStop the rest: verify.mjs down --run=${run}`
      );
    }
  }
  console.log(`UP run=${run} scenario=${scenario} laptops=${laptopCount}`);
  for (const laptop of laptops) console.log(`  laptop-${laptop.index} ${laptop.url} pid=${laptop.pid}`);
  console.log(`  evidence: ${evidenceDir}`);
  console.log(`  drive with: APOLLOON_VERIFY_RUN=${run} node <your-drive-script>.mjs`);
}

// Unpackaged Electron never starts its own server: it always loads http://127.0.0.1:5173.
async function electron() {
  const [state] = selectStates();
  if (!state) return fail('No run. Start one with: verify.mjs up --port=5173');
  if (state.laptops.length !== 1 || state.laptops[0].port !== 5173) {
    return fail('The desktop window only loads port 5173: start the run with --port=5173');
  }
  if (state.electron && alive(state.electron.pid))
    return fail(`Electron already runs for ${state.run}: ${state.electron.cdpUrl}`);
  if (!fs.existsSync(path.join(repoRoot, 'dist-electron/main.js'))) return fail('Run `npm run electron:compile` first');
  const runDir = path.join(scratchRoot, state.run);
  const debugPort = await freePort();
  const logFd = fs.openSync(path.join(runDir, 'electron.log'), 'a');
  // The agent shell exports ELECTRON_RUN_AS_NODE=1, which turns Electron into plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
  const child = spawn(
    path.join(repoRoot, 'node_modules/.bin/electron'),
    [
      '.',
      `--remote-debugging-port=${debugPort}`,
      // No window on the user's screen; the renderer and CDP still work, screenshots included.
      '--ozone-platform=headless',
      // Keeps the user's own desktop profile (window state, .env) untouched.
      `--user-data-dir=${path.join(runDir, 'electron-profile')}`,
    ],
    { cwd: repoRoot, detached: true, stdio: ['ignore', logFd, logFd], env: { ...env, APOLLOON_UPDATE_CHECK: '0' } }
  );
  child.unref();
  state.electron = { pid: child.pid, cdpUrl: `http://127.0.0.1:${debugPort}` };
  fs.writeFileSync(path.join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const targets = await getJson(`${state.electron.cdpUrl}/json/list`);
    if (targets?.some((target) => target.url.startsWith(state.laptops[0].url))) {
      console.log(`ELECTRON run=${state.run} pid=${child.pid} cdp=${state.electron.cdpUrl}`);
      return 0;
    }
    if (!alive(child.pid)) break;
    await sleep(200);
  }
  return fail(`Electron did not load the app. Log: ${path.join(runDir, 'electron.log')}`);
}

async function doctor() {
  const states = selectStates();
  if (!states.length) return fail('No verification runs. Start one with: verify.mjs up');
  let healthy = true;
  const stale = staleBuild();
  if (stale) {
    healthy = false;
    console.log(`BUILD stale: ${stale}`);
  } else {
    console.log('BUILD ok: dist/ and dist-server/ are newer than src/, server/, shared/');
  }
  const head = git('rev-parse', 'HEAD');
  for (const state of states) {
    console.log(`RUN ${state.run} scenario=${state.scenario} started=${state.startedAt}`);
    if (state.commit !== head) {
      healthy = false;
      console.log(`  commit: started at ${state.commit.slice(0, 7)}, HEAD is now ${head.slice(0, 7)} (restart it)`);
    }
    for (const laptop of state.laptops) {
      const problems = [];
      if (!alive(laptop.pid)) problems.push('process is gone');
      else if (!readCmdline(laptop.pid).includes(serverEntry)) problems.push('pid now belongs to another program');
      const owner = portOwner(laptop.port);
      if (owner !== laptop.pid) problems.push(`port ${laptop.port} is owned by ${owner ?? 'nobody'}`);
      const health = await getJson(`${laptop.url}/api/health`);
      const appState = await getJson(`${laptop.url}/api/state`);
      if (!health?.ok) problems.push('/api/health does not answer ok');
      const race = appState?.race;
      const summary = appState
        ? `runners=${appState.runners.length} raceStarted=${Boolean(race.raceStartedAt)} raceFinished=${Boolean(race.raceFinishedAt)}`
        : '';
      let cluster = '';
      if (state.laptops.length > 1)
        cluster = ` cluster=${(await getJson(`${laptop.url}/api/cluster/status`))?.state ?? '?'}`;
      if (problems.length) healthy = false;
      console.log(
        `  laptop-${laptop.index} ${laptop.url} pid=${laptop.pid} ${problems.length ? `PROBLEM: ${problems.join('; ')}` : 'ok'} ${summary}${cluster}`
      );
    }
    if (state.electron) {
      const targets = alive(state.electron.pid) ? await getJson(`${state.electron.cdpUrl}/json/list`) : null;
      const page = targets?.find((target) => target.url.startsWith('http'));
      if (!page) healthy = false;
      console.log(`  electron pid=${state.electron.pid} ${page ? `ok ${page.url}` : 'PROBLEM: no app page over CDP'}`);
    }
    console.log(`  evidence: ${state.evidenceDir}`);
  }
  console.log(healthy ? 'DOCTOR ok' : 'DOCTOR found problems');
  return healthy ? 0 : 1;
}

async function down() {
  const states = selectStates();
  if (!states.length) return console.log('Nothing to stop.');
  for (const state of states) {
    // With a race running, the desktop window asks before closing and ignores SIGTERM.
    if (state.electron && alive(state.electron.pid)) process.kill(-state.electron.pid, 'SIGKILL');
    for (const laptop of state.laptops) {
      // Only stop the process this run started; a reused pid running something else is left alone.
      if (!alive(laptop.pid) || !readCmdline(laptop.pid).includes(serverEntry)) continue;
      process.kill(-laptop.pid, 'SIGTERM');
      // A frozen laptop (SIGSTOP in a failover check) cannot handle SIGTERM until it continues.
      process.kill(-laptop.pid, 'SIGCONT');
      const deadline = Date.now() + 5_000;
      while (alive(laptop.pid) && Date.now() < deadline) await sleep(100);
      if (alive(laptop.pid)) process.kill(-laptop.pid, 'SIGKILL');
    }
    fs.rmSync(path.join(scratchRoot, state.run), { recursive: true, force: true });
    const evidence = fs.existsSync(state.evidenceDir) ? fs.readdirSync(state.evidenceDir) : [];
    console.log(`DOWN run=${state.run}. Evidence kept in ${state.evidenceDir} (${evidence.length} files)`);
  }
  if (fs.existsSync(scratchRoot) && !fs.readdirSync(scratchRoot).length) fs.rmdirSync(scratchRoot);
}

function list() {
  const states = allStates();
  if (!states.length) console.log('No verification runs.');
  for (const state of states) {
    const up = state.laptops.filter((laptop) => alive(laptop.pid)).length;
    console.log(
      `${state.run} scenario=${state.scenario} laptops up=${up}/${state.laptops.length} ${state.laptops[0].url}`
    );
  }
}

function selectStates() {
  if (options.run) {
    const state = readState(options.run);
    return state ? [state] : [];
  }
  return allStates();
}

function allStates() {
  if (!fs.existsSync(scratchRoot)) return [];
  return fs
    .readdirSync(scratchRoot)
    .map((run) => readState(run, { quiet: true }))
    .filter(Boolean);
}

function readState(run, { quiet = false } = {}) {
  const file = path.join(scratchRoot, run, 'state.json');
  if (!fs.existsSync(file)) {
    if (!quiet) console.error(`No run named ${run} in ${scratchRoot}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Returns why the build is older than the source, or null when it is current. */
function staleBuild() {
  for (const entry of [serverEntry, clientEntry]) {
    if (!fs.existsSync(entry)) return `${path.relative(repoRoot, entry)} is missing`;
  }
  const builtAt = Math.min(fs.statSync(serverEntry).mtimeMs, fs.statSync(clientEntry).mtimeMs);
  for (const folder of ['src', 'server', 'shared', 'index.html', 'public']) {
    const newer = newestFile(path.join(repoRoot, folder));
    if (newer && newer.mtimeMs > builtAt) return `${path.relative(repoRoot, newer.file)} changed after the last build`;
  }
  return null;
}

function newestFile(target) {
  if (!fs.existsSync(target)) return null;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return { file: target, mtimeMs: stat.mtimeMs };
  let newest = null;
  for (const name of fs.readdirSync(target)) {
    const candidate = newestFile(path.join(target, name));
    if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) newest = candidate;
  }
  return newest;
}

async function waitForServer(laptop) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!alive(laptop.pid)) return false;
    if (await getJson(`${laptop.url}/api/host-info`)) return true;
    await sleep(100);
  }
  return false;
}

async function getJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function portOwner(port) {
  try {
    const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
    const match = out.match(/pid=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function readCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
}

function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(message);
  return 1;
}
