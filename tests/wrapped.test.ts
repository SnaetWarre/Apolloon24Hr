import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWrapped, formatPlace, wrappedFileNames, type WrappedRunner } from '../src/lib/wrapped.ts';
import type { Label, LapRecord, RaceEvent, Runner, RunnerRegistration } from '../src/types.ts';

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
  const events: RaceEvent[] = [
    {
      id: 'burgie',
      type: 'burgie_gepakt',
      message: '',
      occurredAt: RACE_START + minutes(5 * 60 + 11),
      createdAt: RACE_START + minutes(5 * 60 + 11),
      runnerId: 'r2',
      runnerNumber: '2',
      runnerName: 'Bert Night',
    },
  ];
  return buildWrapped({ runners, laps, registrations, events });
}

const byId = (runners: WrappedRunner[], id: string) => runners.find((entry) => entry.runnerId === id)!;
const assertClose = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

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

test('coefficient places overall and per label, by the label at the time of each lap', () => {
  const runners = buildRace();
  const anna = byId(runners, 'r1');
  // 45 + 20 (double press, no speed bonus) + 57.5, all between 20:00 and 24:00.
  assertClose(anna.points, 122.5);
  assert.deepEqual(anna.pointsRank, { place: 1, of: 3 });
  assert.deepEqual(byId(runners, 'r2').pointsRank, { place: 2, of: 3 });
  assert.deepEqual(byId(runners, 'r3').pointsRank, { place: 3, of: 3 });
  assert.deepEqual(
    anna.labelPointsRanks.map((rank) => [rank.label.id, rank.place, rank.of]),
    [['first-years', 1, 2]]
  );
  // Bert ran one lap with the label and has none now.
  assert.deepEqual(
    byId(runners, 'r2').labelPointsRanks.map((rank) => [rank.label.id, rank.place, rank.of]),
    [['first-years', 2, 2]]
  );
  assert.deepEqual(byId(runners, 'r3').labelPointsRanks, []);
});

test('burgies count the moments a runner was on the track', () => {
  const runners = buildRace();
  assert.equal(byId(runners, 'r2').burgies, 1);
  assert.equal(byId(runners, 'r1').burgies, 0);
});

test('mail addresses stay as typed, and a no to being contacted again means no mail', () => {
  const runners = buildRace();
  assert.equal(byId(runners, 'r1').emailValid, true);
  assert.equal(byId(runners, 'r2').emailValid, false);
  assert.equal(byId(runners, 'r2').email, '///');
  assert.equal(byId(runners, 'r3').refusedContact, true);
  assert.equal(byId(runners, 'r1').refusedContact, false);
});

test('runner types: night runner and team player in a small race', () => {
  const runners = buildRace();
  assert.equal(byId(runners, 'r2').runnerType.title, 'Nachtloper');
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
    buildWrapped({ runners: ids.map((id) => runner(id, id)), laps, registrations: {}, events: [] }).map((entry) => [
      entry.runnerId,
      entry.runnerType,
    ])
  );
  assert.equal(types.get('sprint')?.title, 'Sprinter');
  assert.equal(types.get('many')?.title, 'Kilometervreter');
  assert.equal(types.get('steady')?.title, 'Metronoom');
  assert.equal(types.get('steady')?.text, 'Je rondes lagen nooit meer dan 3 seconden uit elkaar.');
  assert.equal(types.get('a')?.title, 'Teamspeler');
});

test('a place in the top ten reads as a place, further down as a top percentage', () => {
  assert.deepEqual(formatPlace({ place: 3, of: 140 }), { headline: '3e', detail: 'van 140 lopers' });
  assert.deepEqual(formatPlace({ place: 37, of: 140 }), { headline: 'Top 30%', detail: 'plaats 37 van 140' });
});

test('file names sort by number, are safe on Windows, and never collide', () => {
  const names = wrappedFileNames([
    { runnerId: 'a', runnerNumber: '12', name: 'Jan Peeters' },
    { runnerId: 'b', runnerNumber: null, name: 'Jo: "de snelle"?' },
    { runnerId: 'c', runnerNumber: null, name: 'Jo de snelle' },
  ]);
  assert.equal(names.get('a'), '0012 - Jan Peeters.png');
  assert.equal(names.get('b'), 'Jo de snelle.png');
  assert.equal(names.get('c'), 'Jo de snelle (2).png');
});
