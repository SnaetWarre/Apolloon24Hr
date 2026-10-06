import assert from 'node:assert/strict';
import test from 'node:test';
import Papa from 'papaparse';
import { csvText, LAP_COLUMNS, lapRows } from '../server/exports.ts';
import type { LapRecord, Runner } from '../shared/schemas.ts';

function lap(id: string, runnerName: string, finishedAt: number): LapRecord {
  return {
    id,
    runnerId: 'runner-1',
    runnerNumber: '113',
    runnerName,
    lapNumber: 1,
    startedAt: finishedAt - 80_000,
    finishedAt,
    durationMs: 80_000,
    source: 'timing',
    createdAt: finishedAt,
    labels: [],
  };
}

const runner = { id: 'runner-1', historicalAvgMs: null, historicalBestMs: null } as Runner;

test('the laps CSV keeps names from the form from running as Excel formulas', () => {
  const laps = [lap('lap-2', 'Fien Goossens', 2_000_000), lap('lap-1', '=1+1', 1_000_000)];
  const csv = csvText(LAP_COLUMNS, lapRows(laps, [runner]));
  const [, formula, normal] = Papa.parse<string[]>(csv).data;

  assert.equal(formula[2], "'=1+1");
  assert.equal(normal[2], 'Fien Goossens');
  assert.equal(normal[4], '80000');
});

test('the CSV exports quote formulas that span several lines, and leave numbers alone', () => {
  const csv = csvText(
    ['name', 'message', 'lap_time_ms'],
    [
      { name: '=HYPERLINK("http://evil.example","Klik")\nFien', message: '@team', lap_time_ms: 77_125 },
      { name: 'Fien Goossens', message: '+32 470', lap_time_ms: -1 },
    ]
  );
  const [, multiLine, normal] = Papa.parse<string[]>(csv).data;

  assert.deepEqual(multiLine, ['\'=HYPERLINK("http://evil.example","Klik")\nFien', "'@team", '77125']);
  assert.deepEqual(normal, ['Fien Goossens', "'+32 470", '-1']);
});

test('the CSV exports start with a UTF-8 BOM so Excel keeps accented names intact', () => {
  const csv = csvText(['timestamp', 'name'], [{ timestamp: '2026-10-10T18:00:00.000Z', name: 'Zoë Dupré' }]);

  assert.equal(Buffer.from(csv).subarray(0, 3).toString('hex'), 'efbbbf');
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  assert.deepEqual(parsed.meta.fields, ['timestamp', 'name']);
  assert.equal(parsed.data[0].timestamp, '2026-10-10T18:00:00.000Z');
  assert.equal(parsed.data[0].name, 'Zoë Dupré');
});

test('the CSV exports also start with the BOM before the first row', () => {
  const csv = csvText(['timestamp', 'type'], []);

  assert.equal(csv, '﻿timestamp,type\n');
  assert.deepEqual(Papa.parse(csv, { header: true }).meta.fields, ['timestamp', 'type']);
});
