process.env.TZ = 'Europe/Brussels';

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

const runner = { id: 'runner-1', targetLaps: 12, historicalAvgMs: 80_000, historicalBestMs: null } as Runner;

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
  assert.equal(first[6], 12);
  assert.equal(first[8], null);

  assert.equal(events.sheet, 'Gebeurtenissen');
  assert.equal((events.data[1][0] as Date).getUTCHours(), 21);
  assert.equal(events.data[1][1], 'Burgie gepakt');
});

test('the Excel export is an .xlsx file, also before the first lap', async () => {
  const workbook = await raceWorkbook([], [], []);
  assert.equal(workbook.subarray(0, 2).toString(), 'PK');
});
