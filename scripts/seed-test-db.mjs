#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const scenario = args.scenario || 'ready';
const dataPath = path.resolve(repoRoot, args.dataPath || '.test-data');
const keepExisting = Boolean(args.keep);

const SCENARIOS = new Set(['empty', 'ready', 'live', 'large']);
const DEFAULT_HOST_IP = '192.168.24.10';
const BASE_NUMBER = 101;
const RUNNER_NAMES = [
  'Noor Verbruggen',
  'Kobe Janssens',
  'Marcin Delhaye',
  'Lotte Peeters',
  'Sander Wouters',
  'Emma Smets',
  'Ruben Claes',
  'Julie Maes',
  'Bram Lenaerts',
  'Sara De Smet',
  'Milan Jacobs',
  'Ilias Benali',
  'Fien Goossens',
  'Tuur Hermans',
  'Nina Willems',
  'Lars Michiels',
  'Hanne Dierckx',
  'Seppe Mertens',
  'Elise Aerts',
  'Daan Vandenberghe',
  'Mona Cools',
  'Jules Maertens',
  'Amira El Idrissi',
  'Wout Smolders',
  'Lore Van den Bossche',
  'Jonas Geerts',
  'Mila Vercammen',
  'Niels Van Acker',
  'Helena Peeters',
  'Samir Haddad',
  'Anouk De Ridder',
  'Victor Jans',
  'Ella Van Damme',
  'Arne Lauwers',
  'Sofie Baert',
  'Younes Bakkali',
  'Kato Schreurs',
  'Robbe Thys',
  'Lina Verhoeven',
  'Mathis Vermeulen',
];
const LABEL_PATTERNS = [
  ['Speedteam Blue', 'Dames'],
  ['Speedteam White', 'Anciens'],
  ['HILOK', '1ste jaar'],
  ['Mesacosa', 'Dames'],
  ['Kinesia', 'Anciens'],
  ['Speedteam Blue', '1ste jaar'],
  ['Speedteam White', 'HILOK'],
  ['Mesacosa', '1ste jaar'],
  ['Kinesia'],
  ['Dames'],
  ['Anciens'],
  ['1ste jaar'],
  ['HILOK', 'Dames'],
  ['Mesacosa', 'Anciens'],
  ['Kinesia', '1ste jaar'],
  [],
];

if (!SCENARIOS.has(scenario)) {
  fail(`Unknown scenario "${scenario}". Use ${Array.from(SCENARIOS).join(', ')}.`);
}

assertSafeDataPath(dataPath);

if (!keepExisting) {
  fs.rmSync(dataPath, { recursive: true, force: true });
}
fs.mkdirSync(dataPath, { recursive: true });

process.env.DATA_PATH = dataPath;
process.env.HOST_IP_HINT = process.env.HOST_IP_HINT || DEFAULT_HOST_IP;

const db = await import('../server/db.mjs');

await db.initDb();

const seedStartedAt = Date.now();
const runners = scenario === 'empty' ? [] : seedRunners(scenarioRunnerCount(scenario), seedStartedAt);

if (scenario === 'ready') {
  seedReadyQueue(runners, seedStartedAt);
}
if (scenario === 'live') {
  seedLiveRace(runners, seedStartedAt);
}
if (scenario === 'large') {
  seedLargeRace(runners, seedStartedAt);
}

const state = {
  runners: db.getAllRunners(),
  labels: db.getLabels(),
  race: db.getRaceState(),
  laps: db.getAllLaps(),
};
const activeRunner = state.runners.find((runner) => runner.id === state.race.activeRunnerId);

console.log(`Seeded ${scenario} development database`);
console.log(`Data path: ${dataPath}`);
console.log(`Database: ${path.join(dataPath, 'data', 'app.db')}`);
console.log(`Runners: ${state.runners.length}`);
console.log(`Labels: ${state.labels.length}`);
console.log(`Laps: ${state.laps.length}`);
console.log(`Active runner: ${activeRunner ? runnerLabel(activeRunner) : 'none'}`);
console.log(`Race started: ${state.race.raceStartedAt ? new Date(state.race.raceStartedAt).toISOString() : 'no'}`);
console.log('');
console.log('Run with: npm run dev:seeded');

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg.startsWith('--scenario=')) parsed.scenario = arg.slice('--scenario='.length);
    else if (arg.startsWith('--data-path=')) parsed.dataPath = arg.slice('--data-path='.length);
    else if (arg === '--keep') parsed.keep = true;
  }
  return parsed;
}

function assertSafeDataPath(targetPath) {
  const relative = path.relative(repoRoot, targetPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    fail(`Refusing to reset unsafe data path: ${targetPath}`);
  }
  const firstSegment = relative.split(path.sep)[0];
  if (['.', 'data', 'public', 'src', 'server', 'electron', 'scripts'].includes(firstSegment)) {
    fail(`Refusing to reset repo path: ${relative}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function scenarioRunnerCount(name) {
  if (name === 'ready') return 40;
  if (name === 'live') return 60;
  if (name === 'large') return 120;
  return 0;
}

function seedRunners(count, nowMs) {
  const existingByNumber = new Map(db.getAllRunners().map((runner) => [runner.runnerNumber, runner]));
  const runners = [];

  for (let index = 0; index < count; index += 1) {
    const runnerNumber = String(BASE_NUMBER + index);
    const name = nameForIndex(index);
    const registrationSource = scenario === 'large' && index >= count - 8 ? 'manual' : 'import';
    const input = {
      runnerNumber,
      name,
      labels: labelsForIndex(index, scenario),
      targetLaps: targetLapsForIndex(index),
      historicalAvgMs: historicalAvgMsForIndex(index),
      historicalBestMs: historicalAvgMsForIndex(index) - 6_000,
      registrationSource,
      status: 'registered',
      statusSince: nowMs - minutes(index % 60),
      notes: `Seed runner ${index + 1} voor ${scenario} development tests.`,
    };

    const existing = existingByNumber.get(runnerNumber);
    const runner = existing
      ? db.updateRunner(existing.id, input)
      : db.insertRunner(input);
    db.updateRunnerStatus({
      id: runner.id,
      status: 'registered',
      statusSince: nowMs - minutes(index % 60),
    });
    runners.push(db.getRunnerById(runner.id));
  }

  return runners;
}

function seedReadyQueue(runners, nowMs) {
  setStatuses(runners.slice(0, 12), 'waiting', nowMs - minutes(8));
  setStatuses(runners.slice(12, 24), 'warming_up', nowMs - minutes(4));
  setStatuses(runners.slice(24), 'registered', nowMs - minutes(1));
}

function seedLiveRace(runners, nowMs) {
  setStatuses(runners.slice(0, 24), 'waiting', nowMs - minutes(55));
  setStatuses(runners.slice(24, 42), 'warming_up', nowMs - minutes(12));
  setStatuses(runners.slice(42), 'registered', nowMs - minutes(2));
  seedLapHistory({
    runners,
    lapCount: 35,
    nowMs,
    startOffsetMs: minutes(48),
    recycleDelayMs: 30_000,
    retireEvery: 9,
    hiddenRanCount: 0,
  });
}

function seedLargeRace(runners, nowMs) {
  setStatuses(runners.slice(0, 48), 'waiting', nowMs - minutes(360));
  setStatuses(runners.slice(48, 82), 'warming_up', nowMs - minutes(20));
  setStatuses(runners.slice(82), 'registered', nowMs - minutes(3));
  seedLapHistory({
    runners,
    lapCount: 250,
    nowMs,
    startOffsetMs: minutes(345),
    recycleDelayMs: 20_000,
    retireEvery: 22,
    hiddenRanCount: 8,
  });
}

function seedLapHistory({
  runners,
  lapCount,
  nowMs,
  startOffsetMs,
  recycleDelayMs,
  retireEvery,
  hiddenRanCount,
}) {
  const startedAt = nowMs - startOffsetMs;
  db.performHandoff(startedAt);
  const ranRunnerIds = new Set();

  for (let lapIndex = 0; lapIndex < lapCount; lapIndex += 1) {
    const race = db.getRaceState();
    if (!race.activeRunnerId || !race.activeStartedAt) break;

    const duration = lapDurationMs(lapIndex);
    const finishedAt = race.activeStartedAt + duration;
    const previousRunnerId = race.activeRunnerId;
    db.performHandoff(finishedAt);
    ranRunnerIds.add(previousRunnerId);

    const shouldRetireRunner = retireEvery > 0 && (lapIndex + 1) % retireEvery === 0;
    if (!shouldRetireRunner) {
      db.updateRunnerStatus({
        id: previousRunnerId,
        status: 'waiting',
        statusSince: finishedAt + recycleDelayMs,
      });
    }
  }

  const activeRunnerId = db.getRaceState().activeRunnerId;
  const hiddenCandidates = runners
    .filter((runner) => runner.id !== activeRunnerId && ranRunnerIds.has(runner.id))
    .slice(0, hiddenRanCount);

  for (const runner of hiddenCandidates) {
    db.updateRunnerStatus({ id: runner.id, status: 'ran', statusSince: nowMs - minutes(15) });
    db.hideRunnerInQueue(runner.id, nowMs - minutes(10));
  }
}

function setStatuses(runners, status, statusSince) {
  for (const runner of runners) {
    db.updateRunnerStatus({ id: runner.id, status, statusSince });
  }
}

function nameForIndex(index) {
  if (index < RUNNER_NAMES.length) return RUNNER_NAMES[index];
  const base = RUNNER_NAMES[index % RUNNER_NAMES.length];
  const team = Math.floor(index / RUNNER_NAMES.length) + 1;
  return `${base} ${team}`;
}

function labelsForIndex(index, currentScenario) {
  if (currentScenario === 'large' && index >= 112) return [];
  return LABEL_PATTERNS[index % LABEL_PATTERNS.length];
}

function targetLapsForIndex(index) {
  if (index % 8 === 0) return 18;
  if (index % 5 === 0) return 15;
  if (index % 3 === 0) return 12;
  return 9 + (index % 4);
}

function historicalAvgMsForIndex(index) {
  return 64_000 + (index % 18) * 2_200;
}

function lapDurationMs(index) {
  const wave = [63_000, 68_000, 74_000, 81_000, 89_000, 96_000, 103_000, 108_000];
  return wave[index % wave.length] + (index % 5) * 750;
}

function minutes(value) {
  return value * 60 * 1000;
}

function runnerLabel(runner) {
  return runner.runnerNumber ? `${runner.runnerNumber} - ${runner.name}` : runner.name;
}
