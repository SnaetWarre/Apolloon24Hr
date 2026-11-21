import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installHistoryProbe, instrumentBindings } from '../scripts/bench/history-client-page.mjs';
import { median, pairedMedianCI, summarizeHistory } from '../scripts/bench/history-client-stats.mjs';

test('median and paired bootstrap preserve pairs, sign and deterministic intervals', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  const base = [2, 4, 8, 16];
  for (const offset of [-1, 0, 1]) {
    const result = pairedMedianCI(
      base,
      base.map((v) => v + offset)
    );
    assert.deepEqual(result, { delta: offset, low: offset, high: offset, significantlySlower: offset > 0 });
  }
  assert.throws(() => median([]), /nonempty/);
  assert.throws(() => median([NaN]), /finite/);
  assert.throws(() => pairedMedianCI([1], [1, 2]), /pairs/);
  assert.throws(() => pairedMedianCI([1], [1]), /two pairs/);
});

test('summary uses runs, not pushes, and rejects missing pairs or mixed renderers', () => {
  const row = (version, run, workMs) => ({
    n: 500,
    route: 'analysis',
    kind: 'one-lap',
    version,
    run,
    renderer: { kind: 'WebGL2' },
    samples: [{ workMs }, { workMs: workMs + 100 }, { workMs }],
  });
  const rows = [row('base', 0, 10), row('head', 0, 11), row('head', 1, 12), row('base', 1, 11)];
  const [result] = summarizeHistory(rows);
  assert.equal(result.baseMs, 10.5);
  assert.equal(result.headMs, 11.5);
  assert.equal(result.pairs, 2);
  assert.equal(result.ci.significantlySlower, true);
  assert.deepEqual(summarizeHistory([]), []);
  assert.throws(() => summarizeHistory(rows.slice(0, 3)), /missing pair/);
  assert.throws(() => summarizeHistory([...rows, rows[0]]), /duplicate run/);
  const mixed = structuredClone(rows);
  mixed[0].renderer.kind = 'CPU';
  assert.throws(() => summarizeHistory(mixed), /different renderers/);
});

test('callback instrumentation includes cleanup, preserves exceptions and rejects changed bindings', () => {
  const constructor = (name) => `function ${name}(f) {
    const real = (...args) => {
      try { return f(...args); } finally { cleanup(); }
    };
    real._wbg_cb_unref = () => {};
    CLOSURE_DTORS.register(real, state, state);
    return real;
  }`;
  const source = constructor('makeClosure') + constructor('makeMutClosure');
  let active = false,
    cleanups = 0,
    calls = 0;
  const global = {
    __benchInvoke(fn) {
      calls++;
      active = true;
      try {
        return fn();
      } finally {
        active = false;
      }
    },
  };
  const constructors = new Function(
    'globalThis',
    'cleanup',
    `
    const CLOSURE_DTORS = { register() {} }, state = {};
    ${instrumentBindings(source)}; return [makeClosure, makeMutClosure];
  `
  )(global, () => {
    assert(active);
    cleanups++;
  });
  for (const make of constructors) {
    const callback = make((n) => n + 1);
    assert.equal(callback(1), 2);
    assert.equal(callback.__benchRune, true);
    assert.throws(
      make(() => {
        throw new Error('callback failed');
      }),
      /callback failed/
    );
  }
  assert.equal(calls, 4);
  assert.equal(cleanups, 4);
  assert.throws(() => instrumentBindings(''), /constructors/);
});

function browserProbe({ cpuOnly = false, timeoutMs = 1000 } = {}) {
  const clock = { ms: 0 },
    frames = [],
    marks = new Map([['web.handover.done', [{ startTime: 1 }]]]);
  const sandbox = {
    initial: { p: {}, now: 1000 },
    cpuOnly,
    timeoutMs,
    navigator: {},
    HTMLCanvasElement: class {
      getContext() {
        return {};
      }
    },
    performance: { now: () => clock.ms, getEntriesByName: (name) => marks.get(name) ?? [] },
    location: { href: 'http://localhost/' },
    Response,
    URL,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => frames.push(fn),
    fetch: () => {
      throw new Error('unexpected network');
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(`(${installHistoryProbe.toString()})({initial,cpuOnly,timeoutMs})`, sandbox);
  return { sandbox, clock, frames, marks };
}

test('in-page probe excludes preparation and idle time; waits for an applied Rune frame', async () => {
  const { sandbox: s, clock, frames } = browserProbe();
  new s.HTMLCanvasElement().getContext('webgl2');
  await s.fetch('/api/state');
  const poll = s.fetch('/api/state');
  s.__benchPrepare({ p: { latencyLap: 'lap' }, now: 2000 });
  clock.ms = 100;
  const measuring = s.__benchMeasure();
  frames.shift()(0);
  await poll;
  // A Playwright-style RAF must not finish measurement merely because poll applied.
  let finished = false;
  measuring.then(() => {
    finished = true;
  });
  s.requestAnimationFrame(() => {
    s.apolloonLatencyLap = 'lap';
  });
  frames.shift()(0);
  await Promise.resolve();
  assert.equal(finished, false);
  const callback = () =>
    s.__benchInvoke(() => {
      clock.ms += 3;
      s.__benchInvoke(() => {
        clock.ms += 2;
      });
      clock.ms += 2;
    });
  callback.__benchRune = true;
  clock.ms = 120;
  s.requestAnimationFrame(callback);
  frames.shift()(0);
  const result = await measuring;
  assert.equal(result.workMs, 7, 'nested callbacks are counted once');
  assert.equal(result.elapsedMs, 27, 'idle wait is recorded separately');
  assert.equal(result.callbacks, 1);
  assert.equal(result.renderer.kind, 'WebGL2');
});

test('probe detects CPU fallback/loss and errors on unprepared or unapplied pushes', async () => {
  const { sandbox: s, frames, marks } = browserProbe({ cpuOnly: true, timeoutMs: 1 });
  assert.equal(new s.HTMLCanvasElement().getContext('webgl2'), null);
  assert.equal(s.__benchRenderer().kind, 'pending');
  marks.set('web.gpu.failed', [{ startTime: 2 }]);
  assert.equal(s.__benchRenderer().kind, 'CPU');
  await assert.rejects(s.__benchMeasure(), /not prepared/);
  await s.fetch('/api/state');
  const poll = s.fetch('/api/state');
  s.__benchPrepare({ p: { latencyLap: 'lap' }, now: 2000 });
  assert.throws(() => s.__benchPrepare({}), /already pending/);
  const measuring = s.__benchMeasure();
  frames.shift()(0);
  await poll;
  await assert.rejects(measuring, /no applied Rune frame/);
});
