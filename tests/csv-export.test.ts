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
