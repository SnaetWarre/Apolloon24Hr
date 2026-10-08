import assert from 'node:assert/strict';
import test from 'node:test';
import { simulate, type SimResult } from './raft-sim.ts';

/*
 * Runs the consensus simulation for many seeds. A failure prints its seed;
 * replay it exactly, with the whole trace, with
 *
 *   RAFT_SIM_SEED=<seed> npm run test:sim
 *
 * (add RAFT_SIM_REPLACE=1 for a seed of the run where a fourth laptop is
 * taken out of the group) and search more seeds with RAFT_SIM_SEEDS=5000
 * npm run test:sim.
 */

const replaySeed = process.env.RAFT_SIM_SEED;
const seedCount = Number(process.env.RAFT_SIM_SEEDS || 300);
const firstSeed = Number(process.env.RAFT_SIM_FIRST_SEED || 1);
const replaceGone = process.env.RAFT_SIM_REPLACE === '1';

function report(result: SimResult, replace = replaceGone): string {
  return [
    `seed ${result.seed}: ${result.violation}`,
    `replay: RAFT_SIM_SEED=${result.seed}${replace ? ' RAFT_SIM_REPLACE=1' : ''} npm run test:sim`,
    JSON.stringify(result.stats),
    ...result.trace,
  ].join('\n');
}

if (replaySeed) {
  test(`consensus simulation, seed ${replaySeed}`, { timeout: 120_000 }, async () => {
    const result = await simulate({ seed: Number(replaySeed), fullTrace: true, replaceGone });
    if (!result.violation) console.log(result.trace.join('\n'));
    console.log(JSON.stringify(result.stats));
    assert.equal(result.violation, null, report(result));
  });
} else {
  test('a seed replays exactly', async () => {
    const [first, again] = [await simulate({ seed: 7, fullTrace: true }), await simulate({ seed: 7, fullTrace: true })];
    // Every step counts, not just the ones in the trace.
    assert.deepEqual(again, first);
    assert.ok(first.stats.events > 1_000);
  });

  test(
    `consensus holds under crashes, partitions and clock jumps (${seedCount} seeds)`,
    { timeout: 600_000 },
    async () => {
      const totals = { events: 0, terms: 0, acked: 0, resyncs: 0, crashes: 0, clockJumps: 0 };
      for (let seed = firstSeed; seed < firstSeed + seedCount; seed += 1) {
        const result = await simulate({ seed });
        assert.equal(result.violation, null, report(result));
        for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += result.stats[key];
      }
      // The chaos must actually reach the interesting paths, or the test proves little.
      assert.ok(totals.terms > seedCount * 2, `only ${totals.terms} leaderships`);
      assert.ok(totals.acked > seedCount * 10, `only ${totals.acked} confirmed writes`);
      assert.ok(totals.resyncs > seedCount, `only ${totals.resyncs} re-syncs`);
      if (process.env.RAFT_SIM_STATS) console.log(totals);
    }
  );

  test(
    `a laptop gone for good is taken out during the chaos and cannot lead when it comes back (${seedCount} seeds)`,
    { timeout: 600_000 },
    async () => {
      let acked = 0;
      for (let seed = firstSeed; seed < firstSeed + seedCount; seed += 1) {
        const result = await simulate({ seed, replaceGone: true });
        assert.equal(result.violation, null, report(result, true));
        acked += result.stats.acked;
      }
      // Until the broken laptop is out, three of four must answer, so fewer writes get through.
      assert.ok(acked > seedCount * 5, `only ${acked} confirmed writes`);
    }
  );

  test('seeds beyond the usual run that once failed still pass', async () => {
    // 2699: a removal written on a cut-off leader counted as done. 3676: two followers kept a gone leader alive.
    for (const seed of [2699, 3676]) {
      const result = await simulate({ seed, replaceGone: true });
      assert.equal(result.violation, null, report(result, true));
    }
  });
}
