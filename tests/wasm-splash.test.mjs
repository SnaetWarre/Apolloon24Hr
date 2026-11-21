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

test('splash remains after init and is removed only after a presented frame', async () => {
  let presented = false;
  let removed = false;
  let disconnected = false;
  let notify;
  const source = scripts[1]
    .replace("import { followGroup } from '/failover.js';", '')
    .replace("await import('/app.js')", 'await loadApp()');
  const message = { textContent: 'Apolloon laden…' };
  const context = {
    followGroup() {},
    performance: { getEntriesByName: () => (presented ? [{}] : []) },
    requestAnimationFrame: (callback) => callback(),
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
  context.loadApp = async () => {
    throw new Error('network unavailable');
  };
  await vm.runInNewContext(`(async () => {${source}})()`, context);
  assert.equal(removed, false);
  assert.match(message.textContent, /Apolloon kon niet starten: Error: network unavailable/);
});
