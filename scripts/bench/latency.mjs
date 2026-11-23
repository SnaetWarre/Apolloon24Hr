import { percentile } from './metrics.mjs';

export function installBrowserTrace(enabled) {
  if (!enabled) return;
  window.APOLLOON_LATENCY_TRACE = true;
  window.apolloonLatencyEvents = [];
  window.apolloonRefreshIntervals = [];
  const requests = [];
  const fetch = window.fetch;
  window.fetch = async function (...args) {
    const start = performance.now();
    const response = await fetch.apply(this, args);
    if (response.url.includes('/api/state'))
      requests.push({
        url: response.url,
        start,
        requestId: response.headers.get('x-apolloon-trace-request'),
      });
    return response;
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.name.includes('/api/state')) continue;
      const request = requests.filter((r) => r.url === entry.name && r.start <= entry.startTime).at(-1);
      if (!request?.requestId) continue;
      window.apolloonLatencyEvents.push({
        stage: 'http_resource',
        requestId: request.requestId,
        us: (performance.timeOrigin + entry.responseEnd) * 1000,
        responseStartUs: (performance.timeOrigin + entry.responseStart) * 1000,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
        transferSize: entry.transferSize,
      });
      requests.splice(0, requests.indexOf(request) + 1);
    }
  }).observe({ type: 'resource', buffered: true });
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

export function nativeFrameMetrics(events, writes) {
  const ids = new Map(events.filter((e) => e.stage === 'local_commit' && e.lapId).map((e) => [e.id, e.lapId]));
  const native = events
    .filter((e) => e.source === 'native')
    .map((e) => ({ ...e, lapId: e.lapId ?? ids.get(e.id) }))
    .sort((a, b) => a.us - b.us);
  const first = (stage, lap, after = 0) =>
    native.find((e) => e.stage === stage && e.lapId === lap && e.us >= after)?.us;
  const previous = (stage, at) => native.findLast((e) => e.stage === stage && e.us <= at)?.us;
  const overlap = (stage, from, to) => {
    let begin;
    let total = 0;
    for (const event of native) {
      if (event.stage === stage + '_begin') begin = event.us;
      if (event.stage === stage + '_end' && begin !== undefined) {
        total += Math.max(0, Math.min(to, event.us) - Math.max(from, begin));
        begin = undefined;
      }
    }
    return total;
  };
  return writes.map((w) => {
    const input = { lapId: w.lapId };
    const injected = w.sentAt * 1000;
    const key = first('key', w.lapId, injected);
    const receipt = native.findLast(
      (e) =>
        e.stage === 'window_key' &&
        !e.repeat &&
        (e.key === 'Space' || e.key === 'Enter') &&
        e.us >= injected &&
        e.us <= key
    )?.us;
    if ([injected, receipt, key].every(Number.isFinite)) {
      input.injectionReceiptUs = receipt - injected;
      input.receiptKeyUs = key - receipt;
    }
    const push = first('push_received', w.lapId);
    const ready = first('update_ready', w.lapId, push);
    const apply = first('apply_begin', w.lapId, push);
    const applied = first('applied', w.lapId, apply);
    const frame = first('frame', w.lapId, applied);
    const end = previous('present_end', frame);
    const present = previous('present_begin', end);
    const submitted = previous('submit_end', present);
    const submit = previous('submit_begin', submitted);
    const built = previous('build_end', submit);
    const build = previous('build_begin', built);
    const valid =
      [push, ready, apply, applied, frame, build, built, submit, submitted, present, end].every(Number.isFinite) &&
      push <= ready &&
      ready <= apply &&
      apply <= applied &&
      build <= built &&
      applied <= built &&
      built <= submit &&
      submit <= submitted &&
      submitted <= present &&
      present <= end &&
      end <= frame;
    if (!valid) return input;
    const previousSubmitUs = overlap('submit', ready, apply);
    const previousPresentUs = overlap('present', ready, apply);
    const applyUs = applied - apply;
    const detailed = native.some((e) => e.us >= build && e.us <= built && e.stage === 'paint_begin');
    const phaseWork = (stage, excludeApply = false, cpu = false) => {
      let start,
        total,
        depth = 0;
      for (const event of native) {
        if (event.us < build || event.us > built) continue;
        if (event.stage === stage + '_begin') {
          if (depth++ === 0) start = event;
        }
        if (event.stage === stage + '_end') {
          if (depth === 0) return undefined;
          if (--depth !== 0) continue;
          const from = cpu ? start.cpuUs : start.us;
          const to = cpu ? event.cpuUs : event.us;
          if (![from, to].every(Number.isFinite) || to < from) return undefined;
          total = (total ?? 0) + to - from;
          if (excludeApply) total -= Math.max(0, Math.min(event.us, applied) - Math.max(start.us, apply));
        }
      }
      return depth === 0 ? total : undefined;
    };
    const acquireUs = phaseWork('acquire');
    const runtimeUs = phaseWork('runtime', true);
    const phases = {};
    for (const [key, stage] of Object.entries({
      view: 'view',
      commit: 'commit',
      layout: 'layout',
      text: 'text',
      fontFallback: 'font_fallback',
      glyph: 'glyph',
      atlas: 'atlas',
      paint: 'paint',
    })) {
      const work = phaseWork(stage);
      const present = native.some((e) => e.us >= build && e.us <= built && e.stage.startsWith(stage + '_'));
      if (work !== undefined) phases[key + 'Us'] = work;
      else if (detailed && !present) phases[key + 'Us'] = 0;
      const cpu = phaseWork(stage, false, true);
      if (cpu !== undefined) phases[key + 'CpuUs'] = cpu;
    }
    const runtimeCpuUs = phaseWork('runtime', false, true);
    return {
      ...input,
      urgentStateRequests: native.filter((e) => e.stage === 'urgent_state_request' && e.lapId === w.lapId).length,
      urgentStateAdmission: Number(
        native.some(
          (e) =>
            e.stage === 'urgent_state_admission' && e.us >= (previous('redraw_begin', build) ?? build) && e.us <= build
        )
      ),
      pushAppliedUs: applied - push,
      transportReadyUs: ready - push,
      previousSubmitUs,
      previousPresentUs,
      applyUs,
      otherBeforeApplyUs: apply - ready - previousSubmitUs - previousPresentUs,
      buildUs: built - build - Math.max(0, Math.min(built, applied) - Math.max(build, apply)),
      ...(acquireUs === undefined ? {} : { acquireUs }),
      ...(runtimeUs === undefined ? {} : { runtimeUs }),
      ...(runtimeCpuUs === undefined ? {} : { runtimeCpuUs }),
      ...phases,
      encodeUs: submit - built,
      submitUs: submitted - submit,
      presentUs: end - present,
    };
  });
}

export function httpMetrics(events, writes, screens) {
  return screens.flatMap((screen) =>
    writes.map((write) => {
      const source = screen.name === 'native Timing' ? 'native' : screen.name;
      const local = events.filter((e) => e.source === source && e.lapId === write.lapId).sort((a, b) => a.us - b.us);
      const push = local.find((e) => e.stage === 'push_received');
      const parsed = local.findLast(
        (e) => e.stage === 'json_parsed' && e.us <= push?.us && (!push?.requestId || e.requestId === push.requestId)
      );
      const request = parsed?.requestId;
      if (!request) return { screen: screen.name, lapId: write.lapId };
      const points = events.filter((e) => e.requestId === request);
      const at = (stage) => points.find((e) => e.stage === stage)?.us;
      const notify = events.find(
        (e) => e.source === screen.node && e.stage === 'notify' && e.lapId === write.lapId
      )?.us;
      const delta = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : undefined);
      const cacheWaits = ['read_cache_lookup', 'read_cache_lock']
        .map((stage) => delta(at(stage + '_begin'), at(stage + '_ready')))
        .filter(Number.isFinite);
      const localAt = (stage) => local.find((e) => e.stage === stage && e.us >= push?.us)?.us;
      const size = points.find((e) => e.stage === 'http_size');
      const wire = points.find((e) => e.stage === 'wire_body');
      const resource = points.find((e) => e.stage === 'http_resource');
      return {
        screen: screen.name,
        lapId: write.lapId,
        requestId: request,
        notifyWakeUs: delta(notify, at('waiter_wake')),
        workerQueueUs: delta(at('snapshot_dispatch') ?? at('waiter_wake'), at('snapshot_worker')),
        readSnapshotUs: delta(at('snapshot_worker'), at('snapshot_read_ready')),
        historyLockUs: delta(at('history_lock_begin'), at('history_lock_ready')),
        writerLockUs: delta(at('writer_lock_begin'), at('writer_lock_ready')),
        readConnectionUs: delta(at('read_connection_begin'), at('read_connection_ready')),
        readCacheLockUs: cacheWaits.length ? cacheWaits.reduce((a, b) => a + b, 0) : undefined,
        snapshotBuildUs: delta(at('snapshot_read_ready'), at('snapshot_built')),
        serializeUs: delta(at('snapshot_built'), at('snapshot_serialized')),
        stateHistoryUs: delta(at('snapshot_read_ready'), at('history_ready')),
        historySerializeUs: delta(at('history_built'), at('history_ready')),
        liveFieldsUs: delta(at('history_ready'), at('response_ready')),
        responseToProxyUs: delta(at('response_ready'), wire?.headersUs),
        proxyStreamUs: delta(wire?.headersUs, wire?.us),
        proxyToClientBodyUs: delta(wire?.us, at('http_body')),
        headersBodyUs: delta(at('http_headers'), at('http_body')),
        jsonParseUs: delta(at('http_body'), at('json_parsed')),
        clientHistoryUs: delta(push?.us, localAt('history_merged')),
        imagePreparationUs: delta(localAt('history_merged'), localAt('update_ready')),
        updateQueueUs: delta(localAt('update_ready'), localAt('apply_begin')),
        applyUs: delta(localAt('apply_begin'), localAt('applied')),
        decodedBodySize: size?.decodedBodySize ?? resource?.decodedBodySize,
        encodedBodySize: wire?.encodedBodySize ?? resource?.encodedBodySize,
        encoding: wire?.encoding,
      };
    })
  );
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
  const nativeFrames = nativeFrameMetrics(rows, writes);
  const httpRequests = httpMetrics(rows, writes, results);
  for (const screen of results) {
    const requests = httpRequests.filter((r) => r.screen === screen.name);
    for (const key of [
      'notifyWakeUs',
      'workerQueueUs',
      'readSnapshotUs',
      'historyLockUs',
      'writerLockUs',
      'readConnectionUs',
      'readCacheLockUs',
      'snapshotBuildUs',
      'serializeUs',
      'stateHistoryUs',
      'historySerializeUs',
      'liveFieldsUs',
      'responseToProxyUs',
      'proxyStreamUs',
      'proxyToClientBodyUs',
      'headersBodyUs',
      'jsonParseUs',
      'clientHistoryUs',
      'imagePreparationUs',
      'updateQueueUs',
      'applyUs',
    ])
      stages.push({ name: key + ' ' + screen.name, ...stats(requests.map((r) => r[key]).filter(Number.isFinite)) });
  }
  const nativeScreen = results.find((screen) => screen.name === 'native Timing');
  nativeFrames.forEach((frame, i) => {
    const at = first(writes[i].lapId, 'frame', 'native', first(writes[i].lapId, 'applied', 'native'));
    if (nativeScreen?.values[i] != null && Number.isFinite(at))
      frame.framePixelsUs = (writes[i].sentAt + nativeScreen.values[i]) * 1000 - at;
  });
  for (const [key, name] of Object.entries({
    transportReadyUs: 'native push→update ready (transport work)',
    previousSubmitUs: 'native push→apply waiting on previous submit',
    previousPresentUs: 'native push→apply waiting on previous present',
    applyUs: 'native own apply',
    otherBeforeApplyUs: 'native push→apply other transport/scheduling',
    buildUs: 'native view build/acquire excluding apply',
    acquireUs: 'native drawable acquisition (CPU wall time)',
    runtimeUs: 'native runtime view/layout/paint excluding apply',
    runtimeCpuUs: 'native runtime thread CPU including apply (Unix)',
    viewUs: 'native view/tree build',
    commitUs: 'native commit inclusive',
    layoutUs: 'native layout inclusive of text',
    textUs: 'native text shaping/line breaking',
    fontFallbackUs: 'native cold system font fallback',
    glyphUs: 'native glyph preparation/rasterization',
    atlasUs: 'native glyph atlas allocation',
    paintUs: 'native paint preparation inclusive of glyphs',
    encodeUs: 'native upload/encode',
    submitUs: 'native GPU submit (CPU wall time)',
    presentUs: 'native present (CPU wall time)',
  }))
    stages.push({ name, ...stats(nativeFrames.map((f) => f[key]).filter(Number.isFinite)) });
  return {
    stages,
    nativeFrames,
    httpRequests,
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
    '\n\n## Native per press (µs)\n\n| Lap | Injection→winit receipt | Receipt→key | Urgent requests | Urgent (0/1) | Push→apply | Transport ready | Prior submit | Prior present | Own apply | Other before apply | Build/acquire excl. apply | Upload/encode | Submit | Present | Frame→pixels |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n' +
    metrics.nativeFrames
      .map(
        (f) =>
          '| ' +
          [
            f.lapId,
            ...[
              'injectionReceiptUs',
              'receiptKeyUs',
              'urgentStateRequests',
              'urgentStateAdmission',
              'pushAppliedUs',
              'transportReadyUs',
              'previousSubmitUs',
              'previousPresentUs',
              'applyUs',
              'otherBeforeApplyUs',
              'buildUs',
              'encodeUs',
              'submitUs',
              'presentUs',
              'framePixelsUs',
            ].map((k) => f[k] ?? 'N/A'),
          ].join(' | ') +
          ' |'
      )
      .join('\n') +
    '\n\n## Native build phases per press (µs)\n\n| Lap | Acquire | Runtime excl. apply | Runtime CPU incl. apply | View | Commit | Layout | Text | Font fallback | Glyph | Atlas | Paint |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n' +
    metrics.nativeFrames
      .map(
        (f) =>
          '| ' +
          [
            f.lapId,
            ...[
              'acquireUs',
              'runtimeUs',
              'runtimeCpuUs',
              'viewUs',
              'commitUs',
              'layoutUs',
              'textUs',
              'fontFallbackUs',
              'glyphUs',
              'atlasUs',
              'paintUs',
            ].map((key) => f[key] ?? 'N/A'),
          ].join(' | ') +
          ' |'
      )
      .join('\n') +
    '\n\nState response body sizes (bytes, measured requests only): ' +
    JSON.stringify(
      metrics.httpRequests.map(({ screen, lapId, decodedBodySize, encodedBodySize, encoding }) => ({
        screen,
        lapId,
        decodedBodySize,
        encodedBodySize,
        encoding,
      }))
    ) +
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
