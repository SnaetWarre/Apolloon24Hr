import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { median, pairedMedianCI } from './history-client-stats.mjs';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    pairs: { type: 'string', default: '10' },
    out: { type: 'string' },
  },
});
assert(args.base && args.head && args.out, '--base/--head test executables and --out required');
const pairs = Number(args.pairs);
assert(Number.isInteger(pairs) && pairs >= 10, 'at least ten pairs required');
const out = resolve(args.out);
await mkdir(out, { recursive: true });
const exec = promisify(execFile);
const rows = [];
for (const laps of [500, 3000, 10000]) {
  for (let pair = 0; pair < pairs; pair++) {
    for (const version of pair % 2 ? ['head', 'base'] : ['base', 'head']) {
      const { stdout, stderr } = await exec(
        resolve(args[version]),
        ['--ignored', '--exact', 'db::runner_totals_bench::runner_totals_benchmark', '--nocapture'],
        { env: { ...process.env, RUNNER_TOTALS_LAPS: String(laps) }, maxBuffer: 4 * 1024 * 1024 }
      );
      assert.match(stdout, /test result: ok\. 1 passed; 0 failed/);
      const line = stdout.split('\n').find((line) => line.startsWith('RUNNER_TOTALS '));
      assert(line, 'missing benchmark result');
      rows.push({ pair, version, ...JSON.parse(line.slice(14)) });
      await writeFile(join(out, `${laps}-${pair}-${version}.log`), stdout + stderr);
      await writeFile(join(out, 'results.json'), JSON.stringify(rows, null, 2));
    }
  }
}
const summary = [];
for (const laps of [500, 3000, 10000]) {
  for (const metric of ['queryMs', 'stateMs', 'snapshotStateMs']) {
    const samples = (version) =>
      rows.filter((row) => row.laps === laps && row.version === version).map((row) => row[metric]);
    const base = samples('base'),
      head = samples('head');
    summary.push({
      laps,
      metric,
      base: median(base),
      head: median(head),
      percent: (median(head) / median(base) - 1) * 100,
      ci: pairedMedianCI(base, head),
    });
  }
}
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  `PASS: ${rows.length} runs, 3 sizes, ${pairs} interleaved pairs; 50 measured samples per metric/run after 10 warmups`
);
