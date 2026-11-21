import assert from 'node:assert/strict';

export function instrumentBindings(source) {
  const start = 'const real = (...args) => {';
  const end = '    };\n    real._wbg_cb_unref';
  assert.equal(source.split(start).length, 3, 'both callback constructors are wrapped');
  assert.equal(source.split(end).length, 3, 'both callback cleanups are inside the timer');
  source = source.replaceAll(start, 'const real = (...args) => globalThis.__benchInvoke(() => {');
  source = source.replaceAll(end, '    });\n    real._wbg_cb_unref');
  const needle = 'CLOSURE_DTORS.register(real, state, state);';
  assert.equal(source.split(needle).length, 3, 'both callback constructors are tagged');
  return source.replaceAll(needle, `${needle}\n    real.__benchRune = true;`);
}

// Serialized by Playwright: keep all browser-side dependencies inside this function.
export function installHistoryProbe({ initial, cpuOnly, timeoutMs = 15000 }) {
  window.APOLLOON_LATENCY_TRACE = true;
  window.apolloonLatencyEvents = [];
  window.__now = initial.now;
  Date.now = () => window.__now;
  Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true });
  const contexts = new Set();
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...options) {
    if (cpuOnly && ['webgl2', 'webgl', 'experimental-webgl'].includes(kind)) return null;
    const context = getContext.call(this, kind, ...options);
    if (context) contexts.add(kind);
    return context;
  };
  window.__benchRenderer = () => {
    const names = ['web.handover.done', 'web.gpu.failed', 'web.handover.failed', 'web.gpu.lost'];
    const marks = Object.fromEntries(
      names.map((name) => [name, performance.getEntriesByName(name).at(-1)?.startTime ?? -1])
    );
    const failed = Math.max(...names.slice(1).map((name) => marks[name]));
    const kind =
      marks['web.handover.done'] > failed && contexts.has('webgl2')
        ? 'WebGL2'
        : failed >= 0 && failed > marks['web.handover.done']
          ? 'CPU'
          : 'pending';
    return { kind, marks, contexts: [...contexts] };
  };

  let active,
    prepared,
    depth = 0;
  window.__benchInvoke = (fn) => {
    const measure = active;
    if (!measure) return fn();
    const outer = depth++ === 0;
    const start = outer ? performance.now() : 0;
    try {
      return fn();
    } finally {
      depth--;
      if (outer) {
        measure.workMs += performance.now() - start;
        measure.callbacks++;
      }
    }
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    raf((timestamp) => {
      callback(timestamp);
      const measure = active;
      if (!measure || !callback.__benchRune || window.apolloonLatencyLap !== measure.id) return;
      active = null;
      clearTimeout(measure.timer);
      measure.resolve({
        workMs: measure.workMs,
        elapsedMs: performance.now() - measure.start,
        callbacks: measure.callbacks,
        renderer: window.__benchRenderer(),
      });
    });
  const nativeFetch = window.fetch.bind(window);
  const response = (data, url) => {
    const reply = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    Object.defineProperty(reply, 'url', { value: url });
    return reply;
  };
  let first = true;
  window.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname === '/api/clock') return Promise.resolve(response({ serverNowMs: window.__now }, url.href));
    if (url.pathname === '/api/recovery') return Promise.resolve(response(null, url.href));
    if (url.pathname === '/api/state') {
      if (first) {
        first = false;
        return Promise.resolve(response(initial.p, url.href));
      }
      return new Promise((resolve) => {
        window.__deliver = (reply) => {
          window.__deliver = null;
          resolve(reply);
        };
      });
    }
    if (url.pathname === '/api/history') throw new Error('unexpected history fallback');
    return nativeFetch(input, options);
  };
  // Payload transport, serialization and Response construction happen before measurement.
  window.__benchPrepare = ({ p, now }) => {
    if (active || prepared) throw new Error('push already pending');
    prepared = { reply: response(p, new URL('/api/state', location.href).href), now, id: p.latencyLap };
  };
  window.__benchMeasure = () =>
    new Promise((resolve, reject) => {
      if (!prepared || !window.__deliver || active) return reject(new Error('push not prepared or poll not pending'));
      const next = prepared;
      prepared = null;
      // Align delivery with a vsync; elapsedMs includes waiting for the consuming frame.
      raf(() => {
        active = { id: next.id, start: performance.now(), workMs: 0, callbacks: 0, resolve };
        active.timer = setTimeout(() => {
          active = null;
          reject(new Error(`no applied Rune frame for ${next.id}`));
        }, timeoutMs);
        window.__now = next.now;
        window.__deliver(next.reply);
      });
    });
}
