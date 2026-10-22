// A server on UTC, like the VPS: the workbook must still show Brussels clock time.
process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import test from 'node:test';
import { excelSheets, raceWorkbook } from '../server/excel-export.ts';
import type { LapRecord, RaceEvent, Runner, RunnerRegistration } from '../shared/schemas.ts';

function lap(id: string, finishedAt: number, durationMs: number, runnerNumber: string | null = '113'): LapRecord {
  return {
    id,
    runnerId: 'runner-1',
    runnerNumber,
    runnerName: 'Fien Goossens',
    lapNumber: 1,
    startedAt: finishedAt - durationMs,
    finishedAt,
    durationMs,
    source: 'timing',
    createdAt: finishedAt,
    labels: [],
  };
}

const runner = {
  ...rankedRunner('runner-1', '113', 'Fien Goossens', 1),
  historicalAvgMs: 80_000,
  historicalBestMs: null,
};

const event: RaceEvent = {
  id: 'event-1',
  type: 'burgie_gepakt',
  message: 'Burgie gepakt',
  occurredAt: Date.UTC(2026, 9, 10, 19, 0, 0),
  createdAt: Date.UTC(2026, 9, 10, 19, 0, 0),
  runnerId: null,
  runnerNumber: null,
  runnerName: null,
};

test('the Excel export lists laps oldest first in Belgian time, with lap times Excel can calculate with', () => {
  const later = lap('lap-2', Date.UTC(2026, 9, 10, 18, 5, 0), 90_500);
  const earlier = lap('lap-1', Date.UTC(2026, 9, 10, 18, 0, 0), 77_125, 'A7');
  const [laps, events] = excelSheets([later, earlier], [runner], [event], {});

  assert.equal(laps.sheet, 'Rondes');
  assert.equal(laps.data.length, 3);
  const [, first, second] = laps.data;
  // 18:00 UTC is 20:00 in Brussels in October; Excel shows the stored time as it is.
  assert.equal((first[0] as Date).getUTCHours(), 20);
  assert.equal(first[1], 'A7');
  assert.equal(second[1], 113);
  assert.deepEqual(first[4], { value: 77_125 / 86_400_000, format: '[m]:ss.000' });
  assert.deepEqual(first[6], { value: 80_000 / 86_400_000, format: '[m]:ss.000' });
  assert.equal(first[7], null);

  assert.equal(events.sheet, 'Gebeurtenissen');
  assert.equal((events.data[1][0] as Date).getUTCHours(), 21);
  assert.equal(events.data[1][1], 'Burgie gepakt');
});

test('the Excel export shows Brussels clock time in winter and across the change to winter time', () => {
  const winter = lap('lap-1', Date.UTC(2026, 0, 15, 19, 30, 5), 80_000);
  // Clocks go back at 01:00 UTC on 25 October 2026: 00:59 UTC is 02:59 summer time, 01:00 UTC is 02:00 winter time.
  const lastSummer = lap('lap-2', Date.UTC(2026, 9, 25, 0, 59, 0), 80_000);
  const firstWinter = lap('lap-3', Date.UTC(2026, 9, 25, 1, 0, 0), 80_000);
  const [laps] = excelSheets([winter, lastSummer, firstWinter], [runner], [], {});

  const shown = laps.data.slice(1).map((row) => (row[0] as Date).toISOString().slice(11, 19));
  assert.deepEqual(shown, ['20:30:05', '02:59:00', '02:00:00']);
});

test('the Excel export is an .xlsx file, also before the first lap', async () => {
  const workbook = await raceWorkbook([], [], [], {});
  assert.equal(workbook.subarray(0, 2).toString(), 'PK');
});

function rankedRunner(id: string, runnerNumber: string | null, name: string, lapCount: number): Runner {
  return {
    id,
    runnerNumber,
    name,
    notes: '',
    labels: [],
    lapCount,
    bestLapMs: lapCount ? 70_000 : null,
    averageLapMs: lapCount ? 75_000 : null,
    totalTimeMs: lapCount * 75_000,
  } as unknown as Runner;
}

function runnerLap(id: string, runner: Runner, startedAt: number, durationMs: number): LapRecord {
  return {
    ...lap(id, startedAt + durationMs, durationMs, runner.runnerNumber),
    runnerId: runner.id,
    runnerName: runner.name,
  };
}

const registration: RunnerRegistration = {
  submittedAt: '4-10-2026 18:06:40',
  email: 'jan@example.com',
  phone: '0471 12 34 56',
  studyPhase: '2de bach',
  estimatedLaps: '12-15',
  estimatedPace: '1\'15"-1\'17"',
  fastestLap: '1:12',
  maxLapsPerBlock: '3',
  availableHours: ['20-21u (dinsdag)', '12-14u (woensdag)'],
  flexibility: 'Flexibel',
  categories: ['Snelste ronde', 'Nachtloper'],
  reuseConsent: 'Ja',
  remarks: '  =niet aanpassen ',
};

test('the Excel export lists every runner, also without laps, with the registration answers as typed', () => {
  const jan = rankedRunner('jan', '12', 'Jan', 0);
  const els = rankedRunner('els', '3', 'Els', 1);
  const sheets = excelSheets([runnerLap('lap-1', els, Date.UTC(2026, 9, 20, 18), 80_000)], [jan, els], [], {
    jan: registration,
  });
  const runners = sheets.find((sheet) => sheet.sheet === 'Lopers')!;

  assert.deepEqual(
    runners.data.slice(1).map((row) => row[1]),
    ['Els', 'Jan']
  );
  const [, , janRow] = runners.data;
  assert.deepEqual(janRow.slice(3, 7), [0, null, null, null]);
  assert.deepEqual(janRow.slice(7, 20), [
    '4-10-2026 18:06:40',
    'jan@example.com',
    '0471 12 34 56',
    '2de bach',
    '12-15',
    '1\'15"-1\'17"',
    '1:12',
    '3',
    '20-21u (dinsdag), 12-14u (woensdag)',
    'Flexibel',
    'Snelste ronde, Nachtloper',
    'Ja',
    '  =niet aanpassen ',
  ]);

  const ranking = sheets.find((sheet) => sheet.sheet === 'Puntenlijst')!;
  assert.deepEqual(
    ranking.data.slice(1).map((row) => row[2]),
    ['Els']
  );
});

test('the Excel export ranks runners on points, with formulas on the Puntenregels sheet', () => {
  const slow = rankedRunner('slow', '1', 'Traag', 2);
  const fast = rankedRunner('fast', '2', 'Snel', 1);
  // 20:00 in Brussels, factor 1: two laps of 90 s make 40 points, one lap of 65 s makes 70.
  const start = Date.UTC(2026, 9, 20, 18);
  const sheets = excelSheets(
    [
      runnerLap('slow-1', slow, start, 90_000),
      runnerLap('fast-1', fast, start + 90_000, 65_000),
      runnerLap('slow-2', slow, start + 155_000, 90_000),
    ],
    [slow, fast],
    [],
    {}
  );
  const names = sheets.map((sheet) => sheet.sheet);
  assert.deepEqual(names, ['Rondes', 'Gebeurtenissen', 'Lopers', 'Puntenlijst', 'Punten per ronde', 'Puntenregels']);

  const ranking = sheets.find((sheet) => sheet.sheet === 'Puntenlijst')!;
  assert.deepEqual(
    ranking.data.slice(1).map((row) => row[2]),
    ['Snel', 'Traag']
  );
  assert.deepEqual(ranking.data[1][5], {
    type: 'Formula',
    value: "SUMIF('Punten per ronde'!$A:$A,B2,'Punten per ronde'!$I:$I)",
    format: '0.00',
  });

  const perLap = sheets.find((sheet) => sheet.sheet === 'Punten per ronde')!;
  const [, firstLap] = perLap.data;
  assert.equal(firstLap[2], 1);
  assert.deepEqual(firstLap[4], { value: 90, format: '0.000' });
  assert.equal(firstLap[5], '20-24u');
  assert.equal((firstLap[8] as { value: string }).value, "'Puntenregels'!$B$4*G2*H2");

  const rules = sheets.find((sheet) => sheet.sheet === 'Puntenregels')!;
  assert.deepEqual(rules.data[3], ['Basispunten per ronde', 20]);
  assert.deepEqual(rules.data[13], ['20-24u', 20, 24, 1]);
});
