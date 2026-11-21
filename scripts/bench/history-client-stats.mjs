import assert from 'node:assert/strict';

export function median(values) {
  assert(values.length > 0 && values.every(Number.isFinite), 'nonempty finite samples required');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function pairedMedianCI(base, head, repetitions = 20000) {
  assert.equal(base.length, head.length, 'complete base/head pairs required');
  assert(base.length >= 2, 'at least two pairs required');
  assert(Number.isInteger(repetitions) && repetitions >= 100, 'at least 100 bootstrap resamples required');
  const delta = median(head) - median(base);
  let seed = 731;
  const draws = [];
  for (let i = 0; i < repetitions; i++) {
    const b = [],
      h = [];
    for (let j = 0; j < base.length; j++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const index = (seed >>> 0) % base.length;
      b.push(base[index]);
      h.push(head[index]);
    }
    draws.push(median(h) - median(b));
  }
  draws.sort((a, b) => a - b);
  const low = draws[Math.floor(repetitions * 0.025)];
  const high = draws[Math.ceil(repetitions * 0.975) - 1];
  return { delta, low, high, significantlySlower: low > 0 };
}

export function summarizeHistory(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.n, row.route, row.kind]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((group) => {
    const { n, route, kind } = group[0];
    const versions = {};
    for (const version of ['base', 'head']) {
      versions[version] = group.filter((row) => row.version === version).sort((a, b) => a.run - b.run);
      assert(new Set(versions[version].map((row) => row.run)).size === versions[version].length, 'duplicate run');
    }
    assert.deepEqual(
      versions.base.map((row) => row.run),
      versions.head.map((row) => row.run),
      'missing pair'
    );
    const renderers = new Set(group.map((row) => row.renderer.kind));
    assert.equal(renderers.size, 1, 'cannot compare different renderers');
    const base = versions.base.map((row) => median(row.samples.map((sample) => sample.workMs)));
    const head = versions.head.map((row) => median(row.samples.map((sample) => sample.workMs)));
    const b = median(base),
      h = median(head);
    return {
      n,
      route,
      kind,
      pairs: base.length,
      renderer: group[0].renderer.kind,
      baseMs: b,
      headMs: h,
      percent: (h / b - 1) * 100,
      ci: pairedMedianCI(base, head),
      baseRange: [Math.min(...base), Math.max(...base)],
      headRange: [Math.min(...head), Math.max(...head)],
    };
  });
}
