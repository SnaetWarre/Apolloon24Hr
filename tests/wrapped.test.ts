import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWrapped, parseTypedLapTime, wrappedFileNames, type WrappedRunner } from '../src/lib/wrapped.ts';
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
    runner('r1', 'Anna Fast', { historicalBestMs: 72_000, historicalAvgMs: 80_000, labels: [firstYears] }),
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
    r1: registration({ email: 'anna@example.be', estimatedLaps: '2', estimatedPace: '1:20' }),
    r2: registration({ email: '///', estimatedLaps: 'Zo veel mogelijk', estimatedPace: 'snel' }),
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

test('only runners with a lap get a card, and every lap counts', () => {
  const runners = buildRace();
  assert.deepEqual(
    runners.map((entry) => entry.runnerId),
    ['r1', 'r2', 'r3']
  );
  assert.equal(byId(runners, 'r1').laps, 3);
  assert.equal(byId(runners, 'r1').distanceKm, 1.56);
  assert.equal(byId(runners, 'r1').lapShareOfTeam, 0.5);
});

test('lap times skip double presses, split halves, and forgotten handoffs', () => {
  const runners = buildRace();
  const anna = byId(runners, 'r1');
  assert.equal(anna.fastestLapMs, 70_000);
  assert.equal(anna.averageLapMs, 72_500);
  assert.equal(anna.totalTimeOnTrackMs, 145_000);
  assert.equal(byId(runners, 'r2').fastestLapMs, 90_000);
  const cas = byId(runners, 'r3');
  assert.equal(cas.fastestLapMs, null);
  assert.equal(cas.teamRank.fastestLap, null);
});

test('ranks, label ranks by the label at the time of the lap, and night laps', () => {
  const runners = buildRace();
  const anna = byId(runners, 'r1');
  assert.deepEqual(anna.teamRank.laps, { place: 1, of: 3 });
  assert.deepEqual(anna.teamRank.fastestLap, { place: 1, of: 2 });
  assert.deepEqual(
    anna.labelRanks.map((rank) => [rank.label.id, rank.byLaps]),
    [['first-years', { place: 1, of: 2 }]]
  );
  // Bert ran one lap with the label and one without; he has no label now.
  const bert = byId(runners, 'r2');
  assert.deepEqual(bert.labelRanks[0]?.byLaps, { place: 2, of: 2 });
  assert.equal(bert.nightLaps, 2);
  assert.equal(anna.nightLaps, 0);
  assert.equal(anna.longestStreak, 3);
  assert.deepEqual(bert.burgieMoments, [RACE_START + minutes(5 * 60 + 11)]);
  assert.deepEqual(anna.hours, [{ startsAt: RACE_START, label: '20u', laps: 3 }]);
});

test('guesses and last year only count when the typed answer reads cleanly', () => {
  const runners = buildRace();
  const anna = byId(runners, 'r1');
  assert.deepEqual(anna.vsOwnGuess, { estimatedLaps: 2, estimatedPaceMs: 80_000, guessedFastestLapMs: null });
  assert.deepEqual(anna.vsLastYear, { bestDeltaMs: -2_000, averageDeltaMs: -7_500 });
  assert.equal(byId(runners, 'r2').vsOwnGuess, null);
  assert.equal(byId(runners, 'r3').vsOwnGuess, null);
  assert.equal(byId(runners, 'r1').emailValid, true);
  assert.equal(byId(runners, 'r2').emailValid, false);
  assert.equal(byId(runners, 'r2').email, '///');
  // The form asks whether we may contact them again; a mail with the card is contacting them.
  assert.equal(byId(runners, 'r3').refusedContact, true);
  assert.equal(byId(runners, 'r1').refusedContact, false);
});

test('facts come best first and every runner has some', () => {
  const runners = buildRace();
  const anna = byId(runners, 'r1');
  assert.deepEqual(
    anna.facts.slice(0, 4).map((fact) => fact.text),
    [
      'De snelste ronde van de hele 24 uur: 1:10.0',
      'Niemand liep meer rondes dan jij: 3',
      'Nummer 1 van 1ste jaars',
      '2 seconden sneller dan je beste ronde van vorig jaar',
    ]
  );
  assert.ok(anna.facts.some((fact) => fact.text === 'Je schatte 2 rondes, het werden er 3'));
  assert.ok(anna.facts.some((fact) => fact.text === 'Je dacht 1:20 per ronde, het werd gemiddeld 1:12'));
  const bert = byId(runners, 'r2');
  assert.equal(bert.facts[0]?.text, 'Jij liep toen de burgie gepakt werd');
  assert.ok(bert.facts.some((fact) => fact.text === 'Je liep 2 rondes tussen middernacht en 6 uur'));
  const cas = byId(runners, 'r3');
  assert.ok(cas.facts.length >= 2);
  assert.ok(cas.facts.some((fact) => fact.text === '1 ronde voor het team'));
  assert.ok(cas.facts.some((fact) => fact.text === 'Je liep 0,5 km'));
});

test('typed lap times', () => {
  assert.equal(parseTypedLapTime('1:25'), 85_000);
  assert.equal(parseTypedLapTime(" 1'25 "), 85_000);
  assert.equal(parseTypedLapTime('1:25.4'), 85_400);
  assert.equal(parseTypedLapTime('85 sec'), 85_000);
  assert.equal(parseTypedLapTime('85'), null);
  assert.equal(parseTypedLapTime('snel'), null);
  assert.equal(parseTypedLapTime('0:05'), null);
  assert.equal(parseTypedLapTime('1:75'), null);
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
