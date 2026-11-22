import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installClockProbe } from '../scripts/bench/queue-clock-page.mjs';
import { processCpuTicks } from '../scripts/bench/queue-clock-stats.mjs';

test('server CPU parser handles process names with spaces and parentheses and zero CPU', () => {
  const stat = (u, s) => `123 (worker (queue)) S 1 2 3 4 5 6 7 8 9 10 ${u} ${s} 0 0`;
  assert.equal(processCpuTicks(stat(123, 45)), 168);
  assert.equal(processCpuTicks(stat(0, 0)), 0);
});

test('server CPU parser rejects absent, truncated or malformed counters', () => {
  for (const stat of ['', '123 worker', '123 (worker) S', '123 (w) S 1 2 3 4 5 6 7 8 9 10 invalid -1']) {
    assert.throws(() => processCpuTicks(stat));
  }
});

function probe() {
  const sandbox = { now: 0, Date: class {}, requestAnimationFrame: (fn) => fn(0) };
  sandbox.window = sandbox;
  sandbox.performance = { now: () => sandbox.now };
  sandbox.__benchRenderer = () => ({ kind: 'WebGL2' });
  vm.createContext(sandbox);
  vm.runInContext(`(${installClockProbe.toString()})({now:1000})`, sandbox);
  return sandbox;
}

test('clock probe measures outermost WASM work and real-time clock advancement', () => {
  const p = probe();
  p.__clockStart();
  const frame = () =>
    p.__benchInvoke(() => {
      p.now += 3;
      p.__benchInvoke(() => {
        p.now += 5;
      });
    });
  frame.__benchRune = true;
  p.requestAnimationFrame(frame);
  p.now += 12;
  const result = p.__clockStop();
  assert.equal(result.workMs, 8);
  assert.equal(result.callbacks, 1);
  assert.equal(result.frames, 1);
  assert.equal(result.clockElapsedMs, 20);
  assert.equal(result.elapsedMs, 20);
});

test('clock probe excludes preparation and supports an empty measurement', () => {
  const p = probe();
  p.__benchInvoke(() => {
    p.now += 100;
  });
  p.__clockStart();
  p.now++;
  const result = p.__clockStop();
  assert.equal(result.workMs, 0);
  assert.equal(result.callbacks, 0);
  assert.equal(result.elapsedMs, 1);
});

test('clock probe rejects invalid transitions and unwinds failed callbacks', () => {
  const p = probe();
  assert.throws(() => p.__clockStop(), /not measuring/);
  p.__clockStart();
  assert.throws(() => p.__clockStart(), /already measuring/);
  assert.throws(
    () =>
      p.__benchInvoke(() => {
        p.now++;
        throw new Error('callback');
      }),
    /callback/
  );
  p.__benchInvoke(() => {
    p.now++;
  });
  const result = p.__clockStop();
  assert.equal(result.workMs, 2);
  assert.equal(result.callbacks, 2);
});
