import { percentile } from './metrics.mjs';

export function installBrowserTrace(enabled) {
  if (!enabled) return;
  window.APOLLOON_LATENCY_TRACE = true;
  window.apolloonLatencyEvents = [];
  window.apolloonRefreshIntervals = [];
  let lastLap;
  const submitted = (backend) => {
    const id = window.apolloonLatencyLap;
    if (!id || id === lastLap) return;
    lastLap = id;
    window.apolloonLatencyEvents.push({
      stage: 'frame',
      id,
      lapId: id,
      us: (performance.timeOrigin + performance.now()) * 1000,
      backend,
    });
  };
  if (window.GPUCanvasContext && window.GPUQueue) {
    let surface = false;
    const texture = GPUCanvasContext.prototype.getCurrentTexture;
    GPUCanvasContext.prototype.getCurrentTexture = function (...args) {
      const result = texture.apply(this, args);
      if (document.contains(this.canvas)) surface = true;
      return result;
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (...args) {
      const result = submit.apply(this, args);
      if (surface) {
        surface = false;
        submitted('webgpu.surface.submit');
      }
      return result;
    };
  }
  for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!type) continue;
    const flush = type.prototype.flush;
    type.prototype.flush = function (...args) {
      const result = flush.apply(this, args);
      if (document.contains(this.canvas)) submitted('webgl.flush');
      return result;
    };
  }
  const put = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function (...args) {
    const result = put.apply(this, args);
    if (document.contains(this.canvas)) submitted('canvas2d.putImageData');
    return result;
  };
  let previous;
  const refresh = (at) => {
    if (previous !== undefined && window.apolloonRefreshIntervals.length < 60000)
      window.apolloonRefreshIntervals.push((at - previous) * 1000);
    previous = at;
    requestAnimationFrame(refresh);
  };
  requestAnimationFrame(refresh);
  let before = performance.now();
  const steps = [];
  for (let i = 0; i < 10000; i++) {
    const after = performance.now();
    if (after > before) steps.push((after - before) * 1000);
    before = after;
  }
  window.apolloonClockResolutionUs = steps.length ? Math.min(...steps) : null;
}

function stats(values) {
  return { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: percentile(values, 1) };
}

export function stageMetrics(events, writes, results, leader, refresh = []) {
  const ids = new Map(events.filter((e) => e.stage === 'local_commit' && e.lapId).map((e) => [e.id, e.lapId]));
  const rows = events.map((e) => ({ ...e, lapId: e.lapId ?? ids.get(e.id) }));
  const stages = [];
  const first = (lap, stage, source, after = 0) =>
    rows
      .filter((e) => e.lapId === lap && e.stage === stage && e.source === source && e.us >= after)
      .sort((a, b) => a.us - b.us)[0]?.us;
  const add = (name, from, to) => {
    const values = writes.flatMap((write, i) => {
      const a = from(write, i),
        b = to(write, i, a);
      return Number.isFinite(a) && Number.isFinite(b) ? [b - a] : [];
    });
    stages.push({ name, ...stats(values) });
  };
  const origin = leader;
  add(
    'key → POST',
    (w) => first(w.lapId, 'key', 'native'),
    (w) => first(w.lapId, 'post_sent', 'native')
  );
  add(
    'POST → server handler',
    (w) => first(w.lapId, 'post_sent', 'native'),
    (w) => first(w.lapId, 'server_received', origin)
  );
  add(
    'server → durable local commit',
    (w) => first(w.lapId, 'server_received', origin),
    (w) => first(w.lapId, 'local_commit', origin)
  );
  add(
    'commit → majority-complete response boundary',
    (w) => first(w.lapId, 'local_commit', origin),
    (w) => first(w.lapId, 'ack_response', origin)
  );
  add(
    'response boundary → native response body',
    (w) => first(w.lapId, 'ack_response', origin),
    (w) => first(w.lapId, 'client_response', 'native')
  );
  const followers = [...new Set(rows.filter((e) => e.stage === 'replica_apply').map((e) => e.source))];
  for (const source of followers)
    add(
      'commit → replica apply ' + source,
      (w) => first(w.lapId, 'local_commit', origin),
      (w) => first(w.lapId, 'replica_apply', source)
    );
  for (const screen of results) {
    const source = screen.name === 'native Timing' ? 'native' : screen.name;
    const name = screen.name;
    add(
      'notify → push received ' + name,
      (w) => first(w.lapId, 'notify', screen.node),
      (w) => first(w.lapId, 'push_received', source)
    );
    add(
      'push → applied ' + name,
      (w) => first(w.lapId, 'push_received', source),
      (w, _, at) => first(w.lapId, 'applied', source, at)
    );
    add(
      'applied → frame ' + name,
      (w) => first(w.lapId, 'applied', source),
      (w, _, at) => first(w.lapId, 'frame', source, at)
    );
    add(
      'frame → ' + (source === 'native' ? 'pixels ' : 'a11y (NOT pixels) ') + name,
      (w) => first(w.lapId, 'frame', source, first(w.lapId, 'applied', source)),
      (w, i) => (screen.values[i] === null ? undefined : (w.sentAt + screen.values[i]) * 1000)
    );
  }
  const cadence = rows
    .filter((e) => e.source === 'native' && e.stage === 'cadence')
    .map((e) => e.us)
    .sort((a, b) => a - b);
  return {
    stages,
    nativeDrawnFrameIntervalsUs: stats(cadence.slice(1).map((at, i) => at - cadence[i])),
    browserRafIntervalsUs: refresh.map((r) => ({
      screen: r.screen,
      clockResolutionUs: r.clockResolutionUs,
      ...stats(r.intervals),
    })),
    browserFrameBackends: [...new Set(rows.filter((e) => e.backend).map((e) => e.backend))],
  };
}

export function stageMarkdown(metrics) {
  return (
    '\n\n## Opt-in stage trace (µs)\n\n| Stage | n | p50 | p95 | max |\n|---|---:|---:|---:|---:|\n' +
    metrics.stages
      .map((s) => `| ${s.name} | ${s.n} | ${s.p50 ?? 'N/A'} | ${s.p95 ?? 'N/A'} | ${s.max ?? 'N/A'} |`)
      .join('\n') +
    '\n\nNative drawn-frame intervals (actual workload, not physical scanout): ' +
    JSON.stringify(metrics.nativeDrawnFrameIntervalsUs) +
    '\n\nX11 reported display Hz / refresh period µs: ' +
    metrics.reportedDisplayHz +
    ' / ' +
    metrics.reportedRefreshPeriodUs +
    '\n\nChromium rAF intervals: ' +
    JSON.stringify(metrics.browserRafIntervalsUs) +
    '\n\nBrowser frame boundaries: ' +
    metrics.browserFrameBackends.join(', ') +
    '. Missing stages are N/A, never inferred from a timer. Native frame = Rune after-drawn callback (submitted/present queued, not physical scanout). Ack = handler boundary after majority-wait returns, not the internal quorum instant. Browser endpoint remains accessibility, NOT pixels. Timestamp clock is realtime µs (wasm performance.timeOrigin + performance.now; observed resolution above).\n'
  );
}
