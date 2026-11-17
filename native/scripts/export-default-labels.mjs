// This source array contains only literal objects; preserve the existing built-in IDs.
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../server/db/labels.ts', import.meta.url), 'utf8');
const start = source.indexOf('export const DEFAULT_LABELS: DefaultLabel[] = ');
if (start < 0) throw new Error('Default labels declaration moved');
const array = source.slice(start).split('= ')[1].split('\n];')[0] + '\n]';
const labels = vm.runInNewContext(array, Object.create(null), { timeout: 100 });
writeFileSync(new URL('../src/default-labels.json', import.meta.url), JSON.stringify(labels, null, 2) + '\n');
