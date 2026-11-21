import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../native/web/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

test('the app module is preloaded and imported without a dynamic-import delay', () => {
  assert.match(html, /<link rel="modulepreload" href="\/app.js">/);
  assert.match(scripts[1], /import init from '\/app.js';/);
});

test('a module fetch failure leaves a readable startup error on the splash', () => {
  const message = { textContent: 'Apolloon laden…' };
  const handler = html.match(/<script type="module" onerror="([^"]+)"/)[1];
  vm.runInNewContext(handler, { document: { querySelector: () => message } });
  assert.match(message.textContent, /Apolloon kon niet starten/);
});

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
    .replace("import init from '/app.js';", '');
  const message = { textContent: 'Apolloon laden…' };
  const context = {
    followGroup() {},
    performance: { getEntriesByName: () => (presented ? [{}] : []) },
    requestAnimationFrame() {
      assert.fail('the presented frame must not wait behind another animation frame');
    },
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
    init: async () => {},
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
  context.init = () =>
    new Promise((resolve) => {
      finishInit = resolve;
      startedInit();
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
  context.init = async () => {
    throw new Error('network unavailable');
  };
  await vm.runInNewContext(`(async () => {${source}})()`, context);
  assert.equal(removed, false);
  assert.equal(timers.length, 0, 'startup errors must remain visible');
  assert.match(message.textContent, /Apolloon kon niet starten: Error: network unavailable/);
});
