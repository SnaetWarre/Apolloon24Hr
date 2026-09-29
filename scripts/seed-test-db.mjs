#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const scenario = args.scenario || 'ready';
const dataPath = path.resolve(repoRoot, args.dataPath || '.dev-data');
const keepExisting = Boolean(args.keep);

const SCENARIOS = new Set(['empty', 'ready', 'live', 'large']);
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
const LARGE_LABEL_POOL = Array.from(new Set(LABEL_PATTERNS.flat()));
const LARGE_LAP_COUNT_WEIGHTS = [
  [0, 14],
  [1, 24],
  [2, 26],
  [3, 18],
  [4, 10],
  [5, 6],
  [6, 4],
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
const db = await import('../server/db.ts');

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
  temporaryTeams: db.getTemporaryTeams(),
};
const activeRunner = state.runners.find((runner) => runner.id === state.race.activeRunnerId);

console.log(`Seeded ${scenario} development database`);
console.log(`Data path: ${dataPath}`);
console.log(`Database: ${path.join(dataPath, 'data', 'app.db')}`);
console.log(`Runners: ${state.runners.length}`);
console.log(`Labels: ${state.labels.length}`);
console.log(`Laps: ${state.laps.length}`);
console.log(`Temporary teams: ${state.temporaryTeams.length}`);
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
    const historicalAvgMs = historicalAvgMsForIndex(index, scenario);
    const input = {
      runnerNumber,
      name,
      labels: labelsForIndex(index, scenario),
      targetLaps: targetLapsForIndex(index, scenario),
      historicalAvgMs,
      historicalBestMs: historicalBestMsForIndex(index, scenario, historicalAvgMs),
      registrationSource,
      registration: registrationSource === 'import' ? fictionalRegistration(index, name, nowMs) : null,
      status: 'registered',
      statusSince: nowMs - statusAgeMsForIndex(index, scenario),
      notes:
        scenario === 'large'
          ? `Random large seed runner ${index + 1}; bedoeld voor timing-, ranking- en displaytests.`
          : `Seed runner ${index + 1} voor ${scenario} development tests.`,
    };

    const existing = existingByNumber.get(runnerNumber);
    const runner = existing ? db.updateRunner(existing.id, input) : db.insertRunner(input);
    db.updateRunnerStatus({
      id: runner.id,
      status: 'registered',
      statusSince: nowMs - statusAgeMsForIndex(index, scenario),
    });
    runners.push(db.getRunnerById(runner.id));
  }

  return runners;
}

// `21-22u (dinsdag)` for the hour that is running now, in the form's own format,
// or null when now is outside the event window (Tuesday 20:00 for 24 hours).
function currentHourBlock(nowMs) {
  const parts = new Intl.DateTimeFormat('nl-BE', {
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
    timeZone: 'Europe/Brussels',
  }).formatToParts(nowMs);
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? '';
  const hour = Number(part('hour'));
  const weekday = part('weekday').toLowerCase();
  const inWindow = (weekday === 'dinsdag' && hour >= 20) || (weekday === 'woensdag' && hour < 20);
  if (!inWindow) return null;
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(hour)}-${pad((hour + 1) % 24)}u (${weekday})`;
}

// Fictional form answers so profiles, filters and hours can be tested.
// Uses example.be addresses and 0470 00 xx xx numbers; never real people.
function fictionalRegistration(index, name, nowMs) {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z ]/g, '')
    .trim()
    .split(/\s+/)
    .join('.');
  const studyPhases = ['1ste bachelor', '2de bachelor', '3de bachelor', 'master', 'alumnus'];
  const hourBlocks = [
    '20-21u (dinsdag)',
    '21-22u (dinsdag)',
    '22-23u (dinsdag)',
    '23-00u (dinsdag)',
    '00-01u (woensdag)',
    '01-02u (woensdag)',
    '02-03u (woensdag)',
    '03-04u (woensdag)',
    '08-09u (woensdag)',
    '12-13u (woensdag)',
    '16-17u (woensdag)',
    '19-20u (woensdag)',
  ];
  const firstBlock = (index * 3) % hourBlocks.length;
  const pace = 72 + (index % 9) * 3;
  return {
    submittedAt: new Date(nowMs - (30 - (index % 20)) * 86_400_000).toLocaleString('nl-BE'),
    email: `${slug || `loper${index}`}@example.be`,
    phone: `0470 00 ${String(10 + (index % 90)).padStart(2, '0')} ${String((index * 7) % 100).padStart(2, '0')}`,
    studyPhase: studyPhases[index % studyPhases.length],
    estimatedLaps: String(6 + (index % 10)),
    estimatedPace: `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, '0')}`,
    maxLapsPerBlock: String(3 + (index % 4)),
    // During the event window every third runner is also free right now, so the
    // "Nu beschikbaar" panel on Wachtrij has people to call.
    availableHours: [
      ...new Set([
        ...[0, 1, 4].map((offset) => hourBlocks[(firstBlock + offset) % hourBlocks.length]),
        ...(index % 3 === 0 && currentHourBlock(nowMs) ? [currentHourBlock(nowMs)] : []),
      ]),
    ],
    reuseConsent: index % 5 === 0 ? 'Nee' : 'Ja',
    flexibility: index % 3 === 0 ? 'Ik kan inspringen als het moet' : 'Enkel op de opgegeven uren',
    remarks: index % 7 === 0 ? 'Liefst niet twee blokken na elkaar.' : '',
    categories: [],
  };
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
    activeElapsedMs: minutes(1),
    recycleDelayMs: 30_000,
    retireEvery: 9,
    hiddenRanCount: 0,
  });
}

function seedLargeRace(runners, nowMs) {
  const nightTeams = seedTemporaryTeams(runners);
  seedRandomLapHistory({
    runners,
    nowMs,
    nightTeams,
  });
}

function seedTemporaryTeams(runners) {
  const eligible = runners.filter((runner) => runner.labels.some((label) => label.kind === 'speedteam'));
  const definitions = [
    { name: 'Trojan', color: '#7c3aed', icon: 'TR', members: eligible.slice(0, 6) },
    { name: 'Trojan V2', color: '#db2777', icon: 'T2', members: eligible.slice(6, 12) },
  ];
  return definitions.map((definition, index) => {
    const label = db.createLabel({
      name: definition.name,
      color: definition.color,
      icon: definition.icon,
      kind: 'temporary_team',
      sortOrder: 25 + index,
    });
    db.setTemporaryTeamMembers(
      label.id,
      definition.members.map((runner) => runner.id)
    );
    return label.id;
  });
}

function seedRandomLapHistory({ runners, nowMs, nightTeams = [] }) {
  const lapTargets = largeLapTargets(runners);
  const lapSchedule = buildLargeLapSchedule(runners, lapTargets);
  if (!lapSchedule.length) return;

  const activeAfterHistory = pick(runners.filter((runner) => runner.id !== lapSchedule[lapSchedule.length - 1].id));
  const lapDurations = lapSchedule.map((runner, lapIndex) => randomLapDurationMs(runner, lapIndex));
  const totalDurationMs = lapDurations.reduce((sum, duration) => sum + duration, 0);
  const activeElapsedMs = randomInt(minutes(2), minutes(18));
  const startedAt = nowMs - totalDurationMs - activeElapsedMs - randomInt(101, 999);
  let currentStartedAt = startedAt;

  // Night teams cover the middle third of the history.
  const lapStart = (lapIndex) =>
    startedAt + lapDurations.slice(0, lapIndex).reduce((sum, duration) => sum + duration, 0);
  for (const labelId of nightTeams) {
    db.setTemporaryTeamSchedule(
      labelId,
      lapStart(Math.floor(lapSchedule.length / 3)),
      lapStart(Math.floor((lapSchedule.length * 2) / 3))
    );
  }

  db.updateRunnerStatus({
    id: lapSchedule[0].id,
    status: 'waiting',
    statusSince: startedAt - randomInt(3_000, 45_000),
    queueIndex: 0,
  });
  db.performHandoff(startedAt);

  for (let lapIndex = 0; lapIndex < lapSchedule.length; lapIndex += 1) {
    const race = db.getRaceState();
    const currentRunner = lapSchedule[lapIndex];
    if (race.activeRunnerId !== currentRunner.id) {
      fail(`Large seed handoff mismatch at lap ${lapIndex + 1}.`);
    }

    const duration = lapDurations[lapIndex];
    const finishedAt = currentStartedAt + duration;
    const nextRunner = lapSchedule[lapIndex + 1] || activeAfterHistory;

    if (nextRunner) {
      db.updateRunnerStatus({
        id: nextRunner.id,
        status: 'waiting',
        statusSince: finishedAt - randomInt(5_000, 90_000),
        queueIndex: 0,
      });
    }

    db.performHandoff(finishedAt);
    currentStartedAt = finishedAt;
  }

  seedLargeFinalStatuses(runners, nowMs, lapTargets);
}

function seedLapHistory({ runners, lapCount, nowMs, activeElapsedMs, recycleDelayMs, retireEvery, hiddenRanCount }) {
  // The last recorded lap ends `activeElapsedMs` ago, so the active lap started in the past.
  const historyMs = Array.from({ length: lapCount }, (_, index) => lapDurationMs(index)).reduce(
    (sum, ms) => sum + ms,
    0
  );
  const startedAt = nowMs - historyMs - activeElapsedMs;
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

function seedLargeFinalStatuses(runners, nowMs, lapTargets) {
  const activeRunnerId = db.getRaceState().activeRunnerId;
  let waitingIndex = 0;

  for (const runner of shuffle(runners)) {
    if (runner.id === activeRunnerId) continue;

    const lapCount = lapTargets.get(runner.id) || 0;
    const roll = Math.random();
    const status =
      lapCount > 0
        ? roll < 0.48
          ? 'ran'
          : roll < 0.78
            ? 'waiting'
            : roll < 0.9
              ? 'warming_up'
              : 'registered'
        : roll < 0.42
          ? 'registered'
          : roll < 0.7
            ? 'warming_up'
            : 'waiting';

    db.updateRunnerStatus({
      id: runner.id,
      status,
      statusSince: nowMs - randomInt(2_000, minutes(lapCount > 0 ? 70 : 25)),
      queueIndex: status === 'waiting' ? waitingIndex : undefined,
    });

    if (status === 'waiting') waitingIndex += 1;
    if (lapCount > 0 && status === 'ran' && Math.random() < 0.22) {
      db.hideRunnerInQueue(runner.id, nowMs - randomInt(1_000, minutes(20)));
    }
  }
}

function largeLapTargets(runners) {
  const targets = new Map();
  const guaranteedLapCounts = [6, 1, 5, 2, 4, 3, 6, 1, 5, 2, 4, 3];
  const orderedRunners = shuffle(runners);

  orderedRunners.forEach((runner, index) => {
    targets.set(
      runner.id,
      index < guaranteedLapCounts.length ? guaranteedLapCounts[index] : weightedRandom(LARGE_LAP_COUNT_WEIGHTS)
    );
  });

  return targets;
}

function buildLargeLapSchedule(runners, lapTargets) {
  const remaining = new Map(runners.map((runner) => [runner.id, lapTargets.get(runner.id) || 0]));
  const runnersById = new Map(runners.map((runner) => [runner.id, runner]));
  const schedule = [];
  let lastRunnerId = null;
  let remainingLapCount = Array.from(remaining.values()).reduce((sum, count) => sum + count, 0);

  while (remainingLapCount > 0) {
    const candidates = Array.from(remaining.entries())
      .filter(([runnerId, count]) => count > 0 && runnerId !== lastRunnerId)
      .map(([runnerId, count]) => [runnersById.get(runnerId), count])
      .filter(([runner]) => Boolean(runner));
    const fallbackCandidates = Array.from(remaining.entries())
      .filter(([, count]) => count > 0)
      .map(([runnerId, count]) => [runnersById.get(runnerId), count])
      .filter(([runner]) => Boolean(runner));
    const nextRunner = weightedPick(candidates.length ? candidates : fallbackCandidates);

    schedule.push(nextRunner);
    remaining.set(nextRunner.id, (remaining.get(nextRunner.id) || 0) - 1);
    remainingLapCount -= 1;
    lastRunnerId = nextRunner.id;
  }

  return schedule;
}

function nameForIndex(index) {
  if (index < RUNNER_NAMES.length) return RUNNER_NAMES[index];
  const base = RUNNER_NAMES[index % RUNNER_NAMES.length];
  const team = Math.floor(index / RUNNER_NAMES.length) + 1;
  return `${base} ${team}`;
}

function labelsForIndex(index, currentScenario) {
  if (currentScenario === 'large') {
    const labelCount = weightedRandom([
      [0, 8],
      [1, 35],
      [2, 38],
      [3, 16],
      [4, 3],
    ]);
    return shuffle(LARGE_LABEL_POOL).slice(0, labelCount);
  }
  return LABEL_PATTERNS[index % LABEL_PATTERNS.length];
}

function targetLapsForIndex(index, currentScenario) {
  if (currentScenario === 'large') return randomInt(6, 24);
  if (index % 8 === 0) return 18;
  if (index % 5 === 0) return 15;
  if (index % 3 === 0) return 12;
  return 9 + (index % 4);
}

function historicalAvgMsForIndex(index, currentScenario) {
  if (currentScenario === 'large') return randomInt(61_250, 113_950);
  return 64_000 + (index % 18) * 2_200;
}

function historicalBestMsForIndex(index, currentScenario, historicalAvgMs) {
  if (currentScenario === 'large') return Math.max(45_000, historicalAvgMs - randomInt(3_250, 14_975));
  return historicalAvgMsForIndex(index, currentScenario) - 6_000;
}

function statusAgeMsForIndex(index, currentScenario) {
  if (currentScenario === 'large') return randomInt(1_500, minutes(95));
  return minutes(index % 60);
}

function lapDurationMs(index) {
  const wave = [63_000, 68_000, 74_000, 81_000, 89_000, 96_000, 103_000, 108_000];
  return wave[index % wave.length] + (index % 5) * 750;
}

function randomLapDurationMs(runner, lapIndex) {
  const base = runner.historicalAvgMs || historicalAvgMsForIndex(lapIndex, 'large');
  const drift = randomInt(-9_500, 13_750);
  const fatigue = (lapIndex % 6) * randomInt(180, 925);
  const duration = base + drift + fatigue;
  return withVisibleMilliseconds(Math.max(60_000, Math.min(132_995, duration)));
}

function minutes(value) {
  return value * 60 * 1000;
}

function runnerLabel(runner) {
  return runner.runnerNumber ? `${runner.runnerNumber} - ${runner.name}` : runner.name;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(items) {
  return items[randomInt(0, items.length - 1)];
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(0, index);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function weightedRandom(weightedValues) {
  const totalWeight = weightedValues.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = Math.random() * totalWeight;
  for (const [value, weight] of weightedValues) {
    cursor -= weight;
    if (cursor <= 0) return value;
  }
  return weightedValues[weightedValues.length - 1][0];
}

function weightedPick(weightedItems) {
  const totalWeight = weightedItems.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = Math.random() * totalWeight;
  for (const [item, weight] of weightedItems) {
    cursor -= weight;
    if (cursor <= 0) return item;
  }
  return weightedItems[weightedItems.length - 1][0];
}

function withVisibleMilliseconds(value) {
  if (value % 1000 !== 0) return value;
  return value < 132_995 ? value + 137 : value - 137;
}
