import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import writeXlsxFile, { type Sheet } from 'write-excel-file/node';
import { buildWrapped } from '../src/lib/wrapped.ts';
import { findExportRunner, readRaceExport, type ExportRace } from '../scripts/wrapped/export-data.ts';
import type { LapRecord } from '../shared/schemas.ts';
import { brusselsOffsetMs } from '../shared/time.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
// 20:00 in Brussels on the evening the 2026 race started.
const START = Date.UTC(2026, 9, 17, 18, 0, 0);
const MINUTE = 60_000;

type SourceLap = { number: number; name: string; lap: number; finishedAt: number; durationMs: number };
type Loper = [number, string, string, string, string];

const source: SourceLap[] = [
  { number: 12, name: 'Jan Peeters', lap: 1, finishedAt: START + 1 * MINUTE, durationMs: 100_000 },
  { number: 12, name: 'Jan Peeters', lap: 2, finishedAt: START + 3 * MINUTE, durationMs: 93_507 },
  // A double press: a lap, but no lap time.
  { number: 12, name: 'Jan Peeters', lap: 3, finishedAt: START + 4 * MINUTE, durationMs: 15_000 },
  // A forgotten handoff: a lap, but not a believable lap time.
  { number: 12, name: 'Jan Peeters', lap: 4, finishedAt: START + 16 * MINUTE, durationMs: 660_000 },
  { number: 12, name: 'Jan Peeters', lap: 5, finishedAt: START + 18 * MINUTE, durationMs: 101_000 },
  { number: 12, name: 'Jan Peeters', lap: 6, finishedAt: START + 20 * MINUTE, durationMs: 99_999 },
  { number: 7, name: 'Lotte Peeters', lap: 1, finishedAt: START + 21 * MINUTE, durationMs: 110_000 },
  { number: 7, name: 'Lotte Peeters', lap: 2, finishedAt: START + 23 * MINUTE, durationMs: 112_000 },
  { number: 7, name: 'Lotte Peeters', lap: 3, finishedAt: START + 25 * MINUTE, durationMs: 111_000 },
  { number: 7, name: 'Lotte Peeters', lap: 4, finishedAt: START + 27 * MINUTE, durationMs: 109_000 },
];

/** What the app writes: a moment as Brussels clock time without a zone, a lap time as a day fraction. */
const momentCell = (ms: number) => new Date(ms + brusselsOffsetMs(ms));
const lapCell = (ms: number) => ({ value: ms / DAY_MS, format: '[m]:ss.000' });

function workbook(laps: SourceLap[], lopers: Loper[] = []): Sheet<never>[] {
  const lapSheet: Sheet<never> = {
    sheet: 'Rondes',
    data: [
      ['Binnen', 'Nummer', 'Naam', 'Ronde', 'Rondetijd'].map((value) => ({ value, fontWeight: 'bold' })),
      ...laps.map((lap) => [momentCell(lap.finishedAt), lap.number, lap.name, lap.lap, lapCell(lap.durationMs)]),
    ],
    dateFormat: 'dd/mm/yyyy hh:mm:ss',
  };
  if (!lopers.length) return [lapSheet];
  return [
    lapSheet,
    {
      sheet: 'Lopers',
      data: [
        ['Nummer', 'Naam', 'E-mail', 'Toestemming gegevens', 'Ingeschreven op'].map((value) => ({
          value,
          fontWeight: 'bold',
        })),
        ...lopers,
      ],
    },
  ];
}

/** Writes the workbook, reads it back the way the script does, and removes the file again. */
async function readWorkbook(laps: SourceLap[], lopers: Loper[] = []): Promise<ExportRace> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapped-export-'));
  const file = path.join(folder, 'apolloon-race.xlsx');
  await writeXlsxFile(workbook(laps, lopers)).toFile(file);
  try {
    return await readRaceExport(file);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/** The laps as the app had them, for the numbers the conversion has to keep. */
function originalLaps(runnerId: (number: string) => string): LapRecord[] {
  return source.map((lap, index) => ({
    id: `original-${index}`,
    runnerId: runnerId(String(lap.number)),
    runnerNumber: String(lap.number),
    runnerName: lap.name,
    lapNumber: lap.lap,
    startedAt: lap.finishedAt - lap.durationMs,
    finishedAt: lap.finishedAt,
    durationMs: lap.durationMs,
    source: 'handoff',
    createdAt: lap.finishedAt,
    labels: [],
  }));
}

test('the Wrapped numbers survive a trip through the exported workbook', async () => {
  const race = await readWorkbook(source, [
    [12, 'Jan Peeters', 'jan@example.com', 'Ja', '01/09/2026'],
    [7, 'Lotte Peeters', 'lotte@example.com', 'Nee, liever niet', '02/09/2026'],
  ]);
  const runnerId = (number: string) => race.runners.find((runner) => runner.runnerNumber === number)!.id;

  const expected = buildWrapped({
    runners: race.runners,
    laps: originalLaps(runnerId),
    registrations: race.registrations,
    raceStartedAt: race.raceStartedAt,
  });
  const actual = buildWrapped({
    runners: race.runners,
    laps: race.laps,
    registrations: race.registrations,
    raceStartedAt: race.raceStartedAt,
  });
  assert.deepEqual(actual, expected);

  const jan = actual.find((entry) => entry.runnerNumber === '12')!;
  // Every lap counts, but the double press and the forgotten handoff are no lap times.
  assert.equal(jan.laps, 6);
  assert.equal(jan.fastestLapMs, 93_507);
  assert.equal(jan.averageLapMs, Math.round((100_000 + 93_507 + 101_000 + 99_999) / 4));
  assert.equal(jan.meters, 6 * 520);
  assert.equal(jan.email, 'jan@example.com');
  assert.equal(jan.refusedContact, false);
  assert.equal(jan.fastestLap?.number, 2);

  const lotte = actual.find((entry) => entry.runnerNumber === '7')!;
  assert.equal(lotte.refusedContact, true, 'the reuse answer is read from the Lopers sheet');
});

test('a Brussels clock time in winter comes back as the same moment', async () => {
  // 07:30 in Brussels on 1 December, when the clocks are an hour behind.
  const winter = Date.UTC(2026, 11, 1, 6, 30, 0);
  const race = await readWorkbook([{ number: 3, name: 'Noor', lap: 1, finishedAt: winter, durationMs: 95_000 }]);
  assert.equal(race.laps[0].finishedAt, winter);
  assert.equal(race.laps[0].startedAt, winter - 95_000);
  assert.equal(race.raceStartedAt, winter - 95_000);
  assert.equal(race.raceFinishedAt, winter);
});

test('a runner is found by number or by name, and an unknown name lists who is in the file', async () => {
  const race = await readWorkbook(source);
  assert.equal(findExportRunner(race.runners, '12').name, 'Jan Peeters');
  assert.equal(findExportRunner(race.runners, 'jan peeters').runnerNumber, '12');
  assert.equal(findExportRunner(race.runners, 'lotte').runnerNumber, '7');
  assert.throws(() => findExportRunner(race.runners, 'Jurian'), /Geen loper "Jurian"/);
  assert.throws(() => findExportRunner(race.runners, 'peeters'), /meer lopers/);
});
