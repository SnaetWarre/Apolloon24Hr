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

if (!['ready', 'live'].includes(scenario)) {
  fail(`Unknown scenario "${scenario}". Use ready or live.`);
}

assertSafeDataPath(dataPath);

if (!keepExisting) {
  fs.rmSync(dataPath, { recursive: true, force: true });
}
fs.mkdirSync(dataPath, { recursive: true });

process.env.DATA_PATH = dataPath;
process.env.HOST_IP_HINT = process.env.HOST_IP_HINT || '192.168.24.10';

const db = await import('../server/db.mjs');

await db.initDb();

const runners = seedRunners();

if (scenario === 'ready') {
  seedReadyQueue(runners);
} else {
  seedLiveRace(runners);
}

const state = {
  runners: db.getAllRunners(),
  race: db.getRaceState(),
  laps: db.getAllLaps(),
};

console.log(`Seeded ${scenario} test database`);
console.log(`Data path: ${dataPath}`);
console.log(`Database: ${path.join(dataPath, 'data', 'app.db')}`);
console.log(`Runners: ${state.runners.length}`);
console.log(`Laps: ${state.laps.length}`);
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
  if (['.', 'data', 'public', 'src', 'server', 'electron', 'scripts'].includes(relative)) {
    fail(`Refusing to reset repo path: ${relative}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function seedRunners() {
  const specs = [
    {
      runnerNumber: '101',
      name: 'Noor Verbruggen',
      labels: ['Speedteam Blue', 'Dames'],
      targetLaps: 18,
      historicalAvgMs: 67_000,
      historicalBestMs: 61_000,
    },
    {
      runnerNumber: '102',
      name: 'Kobe Janssens',
      labels: ['Speedteam White', 'Anciens'],
      targetLaps: 16,
      historicalAvgMs: 71_000,
      historicalBestMs: 66_000,
    },
    {
      runnerNumber: '103',
      name: 'Marcin Delhaye',
      labels: ['HILOK', '1ste jaar'],
      targetLaps: 12,
      historicalAvgMs: 79_000,
      historicalBestMs: 72_000,
    },
    {
      runnerNumber: '104',
      name: 'Lotte Peeters',
      labels: ['Mesacosa', 'Dames'],
      targetLaps: 10,
      historicalAvgMs: 84_000,
      historicalBestMs: 78_000,
    },
    {
      runnerNumber: '105',
      name: 'Sander Wouters',
      labels: ['Kinesia', 'Anciens'],
      targetLaps: 11,
      historicalAvgMs: 82_000,
      historicalBestMs: 75_000,
    },
    {
      runnerNumber: '106',
      name: 'Emma Smets',
      labels: ['Speedteam Blue', '1ste jaar'],
      targetLaps: 15,
      historicalAvgMs: 73_000,
      historicalBestMs: 68_000,
    },
    {
      runnerNumber: '107',
      name: 'Ruben Claes',
      labels: ['Speedteam White', 'HILOK'],
      targetLaps: 15,
      historicalAvgMs: 74_000,
      historicalBestMs: 69_000,
    },
    {
      runnerNumber: '108',
      name: 'Julie Maes',
      labels: ['Mesacosa', '1ste jaar'],
      targetLaps: 9,
      historicalAvgMs: 88_000,
      historicalBestMs: 81_000,
    },
    {
      runnerNumber: '109',
      name: 'Bram Lenaerts',
      labels: ['Kinesia'],
      targetLaps: 8,
      historicalAvgMs: 92_000,
      historicalBestMs: 86_000,
    },
    {
      runnerNumber: '110',
      name: 'Sara De Smet',
      labels: ['Dames'],
      targetLaps: 7,
      historicalAvgMs: 96_000,
      historicalBestMs: 90_000,
    },
    {
      runnerNumber: '111',
      name: 'Milan Jacobs',
      labels: ['Anciens'],
      targetLaps: 8,
      historicalAvgMs: 93_000,
      historicalBestMs: 85_000,
    },
    {
      runnerNumber: '112',
      name: 'Ilias Benali',
      labels: ['1ste jaar'],
      targetLaps: 7,
      historicalAvgMs: 98_000,
      historicalBestMs: 91_000,
    },
  ];

  return specs.map((spec) =>
    db.insertRunner({
      ...spec,
      status: 'warming_up',
      notes: `Seed runner voor ${scenario} flow tests.`,
    })
  );
}

function seedReadyQueue(runners) {
  for (const runner of runners.slice(0, 7)) {
    db.updateRunnerStatus({ id: runner.id, status: 'waiting' });
  }
}

function seedLiveRace(runners) {
  const baseTime = Date.now() - 16 * 60 * 1000;
  for (const runner of runners.slice(0, 9)) {
    db.updateRunnerStatus({ id: runner.id, status: 'waiting', statusSince: baseTime - 60_000 });
  }

  db.performHandoff(baseTime);

  const lapDurations = [66_000, 72_000, 79_000, 83_000, 69_000, 76_000, 88_000, 74_000, 81_000, 70_000];
  for (const [index, duration] of lapDurations.entries()) {
    const race = db.getRaceState();
    if (!race.activeRunnerId || !race.activeStartedAt) break;
    const finishedAt = race.activeStartedAt + duration;
    const previousActiveRunnerId = race.activeRunnerId;
    db.performHandoff(finishedAt);

    if (index < 8) {
      db.updateRunnerStatus({
        id: previousActiveRunnerId,
        status: 'waiting',
        statusSince: finishedAt + 30_000,
      });
    }
  }

  for (const runner of runners.slice(9)) {
    db.updateRunnerStatus({ id: runner.id, status: 'warming_up', statusSince: Date.now() - 120_000 });
  }
}
