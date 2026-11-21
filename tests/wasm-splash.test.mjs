import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../native/web/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

test('splash theme follows the URL, then the system preference', () => {
  for (const [query, dark, expected] of [
    ['', false, 'light'],
    ['', true, 'dark'],
    ['?thema=licht', true, 'light'],
    ['?thema=donker', false, 'dark'],
    ['?thema=light', true, 'light'],
    ['?thema=dark', false, 'dark'],
    ['?thema=invalid', true, 'dark'],
  ]) {
    const document = { documentElement: { dataset: {} } };
    vm.runInNewContext(scripts[0], {
      document,
      location: { search: query },
      URLSearchParams,
      matchMedia: () => ({ matches: dark }),
    });
    assert.equal(document.documentElement.dataset.theme, expected);
  }
});

test('splash waits for a presented frame, with a three-second fallback after init', async () => {
  let presented = false;
  let removed = false;
  let disconnected = false;
  let notify;
  const timers = [];
  const source = scripts[1]
    .replace("import { followGroup } from '/failover.js';", '')
    .replace("await import('/app.js')", 'await loadApp()');
  const message = { textContent: 'Apolloon laden…' };
  const context = {
    followGroup() {},
    performance: { getEntriesByName: () => (presented ? [{}] : []) },
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    document: { querySelector: (selector) => (selector === '#message' ? message : { remove: () => (removed = true) }) },
    PerformanceObserver: class {
      constructor(callback) {
        notify = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
    loadApp: async () => ({ default: async () => {} }),
    console: { error() {} },
  };
  await vm.runInNewContext(`(async () => {${source}})()`, context);
  assert.equal(removed, false, 'initialization is not a rendered frame');
  notify();
  assert.equal(removed, false, 'unrelated marks do not dismiss the splash');
  presented = true;
  notify();
  assert.equal(removed, true);
  assert.equal(disconnected, true);

  removed = false;
  presented = false;
  disconnected = false;
  timers.length = 0;
  let finishInit;
  let startedInit;
  const initStarted = new Promise((resolve) => (startedInit = resolve));
  context.loadApp = async () => ({
    default: () =>
      new Promise((resolve) => {
        finishInit = resolve;
        startedInit();
      }),
  });
  const initializing = vm.runInNewContext(`(async () => {${source}})()`, context);
  await initStarted;
  assert.equal(timers.length, 0, 'the fallback must not start before init resolves');
  assert.equal(removed, false);
  finishInit();
  await initializing;
  assert.equal(removed, false, 'the splash stays visible during the fallback window');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 3000);
  timers[0].callback();
  assert.equal(removed, true, 'a missing presentation mark must not cover the app forever');
  assert.equal(disconnected, true);

  removed = false;
  timers.length = 0;
  context.loadApp = async () => {
    throw new Error('network unavailable');
  };
  await vm.runInNewContext(`(async () => {${source}})()`, context);
  assert.equal(removed, false);
  assert.equal(timers.length, 0, 'startup errors must remain visible');
  assert.match(message.textContent, /Apolloon kon niet starten: Error: network unavailable/);
});
