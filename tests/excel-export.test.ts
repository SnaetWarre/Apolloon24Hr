// A server on UTC, like the VPS: the workbook must still show Brussels clock time.
process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import test from 'node:test';
import { excelSheets, raceWorkbook } from '../server/excel-export.ts';
import type { LapRecord, RaceEvent, Runner } from '../shared/schemas.ts';

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

const runner = { id: 'runner-1', historicalAvgMs: 80_000, historicalBestMs: null } as Runner;

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
  const [laps, events] = excelSheets([later, earlier], [runner], [event]);

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
  const [laps] = excelSheets([winter, lastSummer, firstWinter], [runner], []);

  const shown = laps.data.slice(1).map((row) => (row[0] as Date).toISOString().slice(11, 19));
  assert.deepEqual(shown, ['20:30:05', '02:59:00', '02:00:00']);
});

test('the Excel export is an .xlsx file, also before the first lap', async () => {
  const workbook = await raceWorkbook([], [], []);
  assert.equal(workbook.subarray(0, 2).toString(), 'PK');
});
