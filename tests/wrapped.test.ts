import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWrapped, formatTimeOfDay, splitName, wrappedFileNames, type WrappedRunner } from '../src/lib/wrapped.ts';
import type { Label, LapRecord, Runner, RunnerRegistration } from '../src/types.ts';

// A made-up race: 20:00 Tuesday to 20:00 Wednesday in Brussels (UTC+2 in September).
const RACE_START = Date.parse('2026-09-22T18:00:00Z');
const minutes = (count: number) => count * 60_000;

const firstYears: Label = {
  id: 'first-years',
  name: '1ste jaars',
  color: '#2877F6',
  icon: 'E',
  kind: 'custom',
  imageUrl: null,
  targetLaps: null,
  sortOrder: 1,
};

const runner = (id: string, name: string, extra: Partial<Runner> = {}): Runner =>
  ({
    id,
    name,
    runnerNumber: id.replace(/\D/g, '') || null,
    labels: [],
    historicalBestMs: null,
    historicalAvgMs: null,
    ...extra,
  }) as Runner;

const registration = (fields: Partial<RunnerRegistration>): RunnerRegistration => ({
  submittedAt: '',
  email: '',
  phone: '',
  studyPhase: '',
  estimatedLaps: '',
  estimatedPace: '',
  maxLapsPerBlock: '',
  availableHours: [],
  reuseConsent: '',
  flexibility: '',
  remarks: '',
  categories: [],
  fastestLap: '',
  ...fields,
});

let lapCount = 0;
function lap(runnerId: string, finishedAt: number, durationMs: number, extra: Partial<LapRecord> = {}): LapRecord {
  lapCount += 1;
  return {
    id: `lap-${lapCount}`,
    runnerId,
    runnerName: runnerId,
    runnerNumber: null,
    lapNumber: lapCount,
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source: 'handoff',
    createdAt: finishedAt,
    labels: [],
    ...extra,
  };
}

function buildRace() {
  const runners = [
    runner('r1', 'Anna Fast', { labels: [firstYears] }),
    runner('r2', 'Bert Night'),
    runner('r3', 'Cas Once'),
    runner('r4', 'Dirk Never'),
  ];
  const laps = [
    // Anna: three laps back to back at 20:00, one of them a double press, and the fastest real lap.
    lap('r1', RACE_START + minutes(2), 75_000, { labels: [firstYears] }),
    lap('r1', RACE_START + minutes(2) + 1_300, 1_300, { labels: [firstYears] }),
    lap('r1', RACE_START + minutes(4), 70_000, { labels: [firstYears] }),
    // Bert: two night laps (01:xx Brussels), one of them a guessed split half that is "faster" than Anna's.
    lap('r2', RACE_START + minutes(5 * 60 + 10), 90_000, { labels: [firstYears] }),
    lap('r2', RACE_START + minutes(5 * 60 + 12), 60_000, { source: 'split' }),
    // Cas: one lap in the afternoon, a forgotten handoff that took 12 minutes.
    lap('r3', RACE_START + minutes(20 * 60), minutes(12)),
  ];
  const registrations: Record<string, RunnerRegistration> = {
    r1: registration({ email: 'anna@example.be' }),
    r2: registration({ email: '///' }),
    r3: registration({ email: 'cas@example.be', reuseConsent: 'Nee' }),
  };
  return buildWrapped({ runners, laps, registrations, raceStartedAt: RACE_START });
}

const byId = (runners: WrappedRunner[], id: string) => runners.find((entry) => entry.runnerId === id)!;

test('only runners with a lap get a card, and every lap counts', () => {
  const runners = buildRace();
  assert.deepEqual(
    runners.map((entry) => entry.runnerId),
    ['r1', 'r2', 'r3']
  );
  assert.equal(byId(runners, 'r1').laps, 3);
  assert.equal(byId(runners, 'r2').laps, 2);
});

test('lap times skip double presses, split halves, and forgotten handoffs', () => {
  const runners = buildRace();
  const anna = byId(runners, 'r1');
  assert.equal(anna.fastestLapMs, 70_000);
  assert.equal(anna.averageLapMs, 72_500);
  assert.equal(byId(runners, 'r2').fastestLapMs, 90_000);
  assert.equal(byId(runners, 'r3').fastestLapMs, null);
  assert.equal(byId(runners, 'r3').averageLapMs, null);
});

test('names, distance, and the share of runners with fewer laps', () => {
  const runners = buildRace();
  const anna = byId(runners, 'r1');
  assert.deepEqual([anna.firstName, anna.lastName], ['Anna', 'Fast']);
  assert.equal(anna.meters, 1560);
  assert.equal(anna.lapsBeatenPercent, 66);
  assert.equal(byId(runners, 'r2').lapsBeatenPercent, 33);
  assert.equal(byId(runners, 'r3').lapsBeatenPercent, 0);
  assert.deepEqual(splitName('  Jan  Van den Bossche '), ['Jan', 'Van den Bossche']);
  assert.deepEqual(splitName('Cher'), ['Cher', '']);
});

test('the fastest lap: which of their own laps, when, and its place among everyone', () => {
  const runners = buildRace();
  // Anna's second lap was a double press, so her fastest real lap is her third.
  assert.deepEqual(byId(runners, 'r1').fastestLap, { number: 3, finishedAt: RACE_START + minutes(4), place: 1 });
  assert.equal(byId(runners, 'r2').fastestLap?.place, 2);
  assert.equal(byId(runners, 'r3').fastestLap, null);
  assert.equal(formatTimeOfDay(RACE_START + minutes(7 * 60 + 41)), "03:41 's nachts");
  assert.equal(formatTimeOfDay(RACE_START + minutes(15 * 60)), "11:00 's ochtends");
});

test('laps per hour count from the hour the race started', () => {
  const runners = buildRace();
  assert.equal(byId(runners, 'r1').lapsPerHour.length, 24);
  assert.equal(byId(runners, 'r1').lapsPerHour[0], 3);
  assert.equal(byId(runners, 'r2').lapsPerHour[5], 2);
  assert.equal(byId(runners, 'r3').lapsPerHour[20], 1);
});

test('mail addresses stay as typed, and a no to being contacted again means no mail', () => {
  const runners = buildRace();
  assert.equal(byId(runners, 'r1').emailValid, true);
  assert.equal(byId(runners, 'r2').emailValid, false);
  assert.equal(byId(runners, 'r2').email, '///');
  assert.equal(byId(runners, 'r3').refusedContact, true);
  assert.equal(byId(runners, 'r1').refusedContact, false);
});

test('runner types: night owl and team player in a small race', () => {
  const runners = buildRace();
  assert.equal(byId(runners, 'r2').runnerType.title, 'Nachtuil');
  assert.equal(byId(runners, 'r2').runnerType.text, 'Al je 2 rondes waren tussen 00:00 en 06:00');
  assert.deepEqual(byId(runners, 'r2').runnerType.hours, { from: 0, to: 6 });
  assert.equal(byId(runners, 'r1').runnerType.title, 'Teamspeler');
  assert.equal(byId(runners, 'r3').runnerType.title, 'Teamspeler');
});

test('runner types: sprinter, most laps, and a steady pace', () => {
  const durations: Record<string, number[]> = {
    sprint: [60_000, 70_000, 80_000],
    many: [80_000, 90_000, 100_000, 80_000, 90_000, 100_000],
    steady: [85_000, 86_000, 87_500],
  };
  const ids = ['sprint', 'many', 'steady', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
  let at = RACE_START;
  const laps = ids.flatMap((id) => (durations[id] ?? [80_000, 90_000, 100_000]).map((ms) => lap(id, (at += ms), ms)));
  const types = new Map(
    buildWrapped({ runners: ids.map((id) => runner(id, id)), laps, registrations: {}, raceStartedAt: RACE_START }).map(
      (entry) => [entry.runnerId, entry.runnerType]
    )
  );
  assert.equal(types.get('sprint')?.title, 'Sprinter');
  assert.equal(types.get('many')?.title, 'Kilometervreter');
  assert.equal(types.get('many')?.text, 'Niemand liep meer rondes dan jij');
  assert.equal(types.get('steady')?.title, 'Metronoom');
  assert.equal(types.get('steady')?.text, 'Je rondes lagen nooit meer dan 3 seconden uit elkaar');
  assert.equal(types.get('a')?.title, 'Teamspeler');
});

test('runner types: a tie at the edge of the top 10% is no Kilometervreter', () => {
  const ids = [
    'a',
    'b',
    'c',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'm',
    'n',
    'o',
    'p',
    'q',
    'first',
    'second',
    'third',
  ];
  const lapCount: Record<string, number> = { first: 8, second: 6, third: 6 };
  let at = RACE_START;
  // Every runner has their own fastest lap, so only 'a' and 'b' are Sprinters.
  const laps = ids.flatMap((id, runnerIndex) =>
    Array.from({ length: lapCount[id] ?? 1 }, () => lap(id, (at += 90_000), 70_000 + runnerIndex * 1_000))
  );
  const types = new Map(
    buildWrapped({ runners: ids.map((id) => runner(id, id)), laps, registrations: {}, raceStartedAt: RACE_START }).map(
      (entry) => [entry.runnerId, entry.runnerType]
    )
  );
  // 'second' is second of 20, but shares that place with 'third', so it ran more laps than only 85%.
  assert.equal(types.get('first')?.title, 'Kilometervreter');
  assert.notEqual(types.get('second')?.title, 'Kilometervreter');
  assert.notEqual(types.get('third')?.title, 'Kilometervreter');
});

test('file names sort by number, are safe on Windows, and never collide', () => {
  const names = wrappedFileNames([
    { runnerId: 'a', runnerNumber: '12', name: 'Jan Peeters' },
    { runnerId: 'b', runnerNumber: null, name: 'Jo: "de snelle"?' },
    { runnerId: 'c', runnerNumber: null, name: 'Jo de snelle' },
  ]);
  assert.equal(names.get('a'), '0012 - Jan Peeters');
  assert.equal(names.get('b'), 'Jo de snelle');
  assert.equal(names.get('c'), 'Jo de snelle (2)');
});
