import assert from 'node:assert/strict';
import test from 'node:test';
import { simulate, type SimResult } from './raft-sim.ts';

/*
 * Runs the consensus simulation for many seeds. A failure prints its seed;
 * replay it exactly, with the whole trace, with
 *
 *   RAFT_SIM_SEED=<seed> npm run test:sim
 *
 * and search more seeds with RAFT_SIM_SEEDS=5000 npm run test:sim.
 */

const replaySeed = process.env.RAFT_SIM_SEED;
const seedCount = Number(process.env.RAFT_SIM_SEEDS || 300);
const firstSeed = Number(process.env.RAFT_SIM_FIRST_SEED || 1);

function report(result: SimResult): string {
  return [
    `seed ${result.seed}: ${result.violation}`,
    `replay: RAFT_SIM_SEED=${result.seed} npm run test:sim`,
    JSON.stringify(result.stats),
    ...result.trace,
  ].join('\n');
}

if (replaySeed) {
  test(`consensus simulation, seed ${replaySeed}`, { timeout: 120_000 }, async () => {
    const result = await simulate({ seed: Number(replaySeed), fullTrace: true });
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
}
