import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, stat, writeFile, open } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { request as httpRequest } from 'node:http';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));
export function options(args) {
  const config = {
    hours: 24,
    ratio: 60,
    out: '.tmp-stress-results',
    work: '.tmp-stress',
    binary: 'native/target/release/apolloon-native',
    seed: 'apolloon-24',
    backups: true,
  };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    if (
      !['hours', 'ratio', 'out', 'work', 'binary', 'seed', 'compare'].includes(key) ||
      !args[i].startsWith('--') ||
      !args[i + 1]
    )
      throw new Error(`Invalid flag: ${args[i]}`);
    config[key] = ['hours', 'ratio'].includes(key) ? Number(args[i + 1]) : args[i + 1];
  }
  if (![config.hours, config.ratio].every((n) => Number.isFinite(n) && n > 0))
    throw new Error('hours and ratio must be positive finite numbers');
  const nested = relative(resolve(config.out), resolve(config.work));
  if (!nested || (nested !== '..' && !nested.startsWith('../') && !isAbsolute(nested)))
    throw new Error('--work must be outside --out');
  return config;
}
export function schedule(hours, seed) {
  let x = 2166136261;
  for (const c of String(seed)) x = Math.imul(x ^ c.charCodeAt(0), 16777619);
  const random = () => {
    x += 0x6d2b79f5;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const laps = [];
  for (let seconds = 60 + random() * 30; seconds < hours * 3600; seconds += 60 + random() * 30) {
    laps.push(seconds);
    if (laps.length % 80 === 0) for (let j = 1; j <= 3; j++) laps.push(seconds + j * 2);
  }
  return {
    laps,
    chaos: ['follower-freeze', 'leader-freeze', 'laptop-out', 'leader-terminate', 'two-down'].map((kind, i) => ({
      kind,
      raceSeconds: hours * 3600 * [0.12, 0.28, 0.45, 0.67, 0.84][i],
      outageRaceHours: kind === 'laptop-out' ? 1 + random() : null,
    })),
  };
}
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (fraction) => (sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null);
  return { count: sorted.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: p(1) };
}
export function historyPath(cursor) {
  return '/api/history?scope=full' + (cursor ? `&since=${encodeURIComponent(cursor)}` : '');
}
export function endpointKey(path) {
  return path.startsWith('/api/history?scope=full&since=') ? '/api/history?scope=full&since' : path;
}
export async function responseBody(url, body) {
  return new Promise((done, reject) => {
    const request = httpRequest(
      url,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, br' },
        signal: AbortSignal.timeout(1800),
      },
      (response) => {
        const chunks = [];
        response.on('error', reject);
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            const encoded = Buffer.concat(chunks),
              encoding = response.headers['content-encoding'] ?? 'identity';
            const decoded =
              encoding === 'gzip' ? gunzipSync(encoded) : encoding === 'br' ? brotliDecompressSync(encoded) : encoded;
            done({
              status: response.statusCode,
              encoding,
              encodedBytes: encoded.length,
              bytes: decoded.length,
              raw: decoded.toString('utf8'),
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
export function errorClass(record, injectedUnavailable) {
  if (record.status !== undefined) return 'liveResponse';
  return injectedUnavailable ? 'injectedUnavailable' : 'liveTransport';
}
export function writeErrorSummary(requests) {
  const errors = requests.filter((r) => r.write && r.error);
  const count = (rows) => ({
    insideChaos: rows.filter((r) => r.chaos).length,
    outsideChaos: rows.filter((r) => !r.chaos).length,
    total: rows.length,
  });
  return {
    ...count(errors),
    byCause: Object.fromEntries(
      ['injectedUnavailable', 'liveResponse', 'liveTransport', 'noWritableLeader'].map((cause) => [
        cause,
        count(errors.filter((r) => r.errorClass === cause)),
      ])
    ),
  };
}
export function recoveryTiming(began, downAt, restoreAt, caughtUpAt, recoveredAt) {
  return {
    timingOrigin: 'restore',
    outageMs: restoreAt - downAt,
    caughtUpMs: caughtUpAt - restoreAt,
    recoveryMs: recoveredAt - restoreAt,
    disruptionMs: recoveredAt - began,
  };
}
export function compactSummary(result) {
  const {
    requests,
    acknowledgements,
    schedule: plan,
    final,
    histories: _histories,
    resources,
    events,
    ...summary
  } = result;
  const sampled = [];
  for (const name of new Set(resources.map((r) => r.node))) {
    const rows = resources.filter((r) => r.node === name);
    const count = Math.min(rows.length, 120);
    for (let i = 0; i < count; i++)
      sampled.push(rows[count === 1 ? 0 : Math.round((i * (rows.length - 1)) / (count - 1))]);
  }
  return {
    ...summary,
    kind: 'apolloon-race-stress',
    schemaVersion: 2,
    counts: {
      requests: requests.length,
      acknowledgedLaps: acknowledgements.length,
      scheduledLaps: plan.laps.length,
      failedAttempts: events.filter((e) => e.kind === 'write-attempt-error').length,
    },
    resources: sampled,
    resourceSampling: {
      originalCount: resources.length,
      retainedCount: sampled.length,
      method: 'uniform per node, max 120; growth/peaks use all samples',
    },
    events: events.filter((e) => e.kind !== 'write-attempt-error'),
    final: final ? { statuses: final.statuses, lapCounts: final.lapIds.map((ids) => ids.length) } : null,
  };
}
export function isRunSummary(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.passed === 'boolean' &&
    value.config &&
    value.metrics &&
    Array.isArray(value.growth) &&
    Array.isArray(value.events)
  );
}
export async function latestRun(out) {
  const candidates = await Promise.all(
    (await readdir(out))
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        const file = join(out, f);
        try {
          return isRunSummary(JSON.parse(await readFile(file, 'utf8')))
            ? { file, time: (await stat(file)).mtimeMs }
            : null;
        } catch {
          return null;
        }
      })
  );
  return candidates.filter(Boolean).sort((a, b) => b.time - a.time)[0]?.file;
}
export async function main(args = process.argv.slice(2)) {
  const config = options(args);
  config.binary = resolve(config.binary);
  config.gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  config.machine = {
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    ramBytes: os.totalmem(),
    platform: os.platform(),
  };
  const plan = schedule(config.hours, config.seed);
  const out = resolve(config.out);
  const work = resolve(config.work);
  await Promise.all([mkdir(out, { recursive: true }), mkdir(work, { recursive: true })]);
  const id = new Date().toISOString().replaceAll(':', '-');
  const directory = join(work, `run-${id}`);
  await mkdir(directory);
  const result = {
    config,
    schedule: plan,
    directory,
    requests: [],
    resources: [],
    events: [],
    acknowledgements: [],
    failures: [],
  };
  const nodes = [];
  let epoch = null,
    stopped = false,
    chaos = null,
    rotation = 0;
  const stamp = () => ({
    wallAt: new Date().toISOString(),
    wallMs: epoch === null ? 0 : Date.now() - epoch,
    raceSeconds: epoch === null ? 0 : ((Date.now() - epoch) * config.ratio) / 1000,
    phase: epoch === null ? 'setup' : stopped ? 'validation' : 'race',
  });
  async function request(node, path, body) {
    const start = performance.now(),
      window = chaos;
    const record = { ...stamp(), node: node.name, endpoint: endpointKey(path), path, write: body !== undefined };
    const wasUnavailable = node.injectedUnavailable,
      interruptions = node.interruptions;
    try {
      const response = await responseBody(node.url + path, body);
      record.status = response.status;
      record.bytes = response.bytes;
      record.encodedBytes = response.encodedBytes;
      record.encoding = response.encoding;
      if (response.status < 200 || response.status >= 300)
        throw new Error(`HTTP ${response.status}: ${response.raw.slice(0, 400)}`);
      const value = JSON.parse(response.raw);
      if (path.startsWith('/api/history'))
        record.historyKind = value.delta === true ? 'delta' : path.includes('scope=recent') ? 'recent' : 'full';
      return value;
    } catch (error) {
      record.error = error.message;
      record.errorClass = errorClass(
        record,
        wasUnavailable || node.injectedUnavailable || interruptions !== node.interruptions
      );
      throw error;
    } finally {
      record.ms = performance.now() - start;
      record.chaos = window?.kind ?? chaos?.kind ?? null;
      result.requests.push(record);
    }
  }
  const action = (node, method, body) => request(node, `/api/action/${method}`, body);
  const status = (node) => request(node, '/api/cluster/status');
  async function until(fn, label, timeout = 25000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const value = await fn();
        if (value) return value;
      } catch {}
      await sleep(100);
    }
    throw new Error(`Timed out: ${label}`);
  }
  async function start(node) {
    const log = await open(join(directory, `${node.name}.log`), 'a');
    node.child = spawn(config.binary, ['--server'], {
      stdio: ['ignore', log.fd, log.fd],
      env: {
        ...process.env,
        PORT: String(node.port),
        APOLLOON_NATIVE_DATA: node.db,
        CLUSTER_ENABLED: 'true',
        CLUSTER_DISCOVERY: 'false',
        CLUSTER_AUTO_LINK: 'false',
        CLUSTER_SELF_URL: node.url,
        CLUSTER_LAPTOP_NAME: node.name,
        BACKUP_ENABLED: String(config.backups),
      },
    });
    node.child.on('error', (error) => result.failures.push(`${node.name}: ${error.message}`));
    await log.close();
    await until(() => request(node, '/api/health'), `${node.name} startup`);
    node.injectedUnavailable = false;
  }
  async function kill(node, signal) {
    const child = node.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGCONT');
    child.kill(signal);
    await exited;
  }
  async function leader() {
    return Promise.any(
      nodes.map(async (node) => {
        const s = await status(node);
        if (s.role !== 'leader' || !s.writable) throw new Error('Not a writable leader');
        return node;
      })
    ).catch(() => {
      throw new Error('No writable leader');
    });
  }
  async function healthy() {
    const states = await Promise.all(nodes.map(status));
    return (
      states.every(
        (s) =>
          s.writable &&
          !s.busy &&
          s.members.length === 3 &&
          s.logHead === states[0].logHead &&
          s.clusterId === states[0].clusterId
      ) && states.filter((s) => s.role === 'leader').length === 1
    );
  }
  let probe;
  async function timing(method) {
    const began = performance.now(),
      at = stamp(),
      window = chaos;
    let current;
    try {
      current = await leader();
    } catch (error) {
      result.requests.push({
        ...at,
        endpoint: `/api/action/${method}`,
        write: true,
        error: error.message,
        errorClass: 'noWritableLeader',
        chaos: window?.kind ?? chaos?.kind ?? null,
        ms: performance.now() - began,
      });
      throw error;
    }
    const { race } = await request(current, '/api/state');
    const response = await action(nodes[rotation++ % 3], method, {
      activeRunnerId: race.activeRunnerId,
      activeStartedAt: race.activeStartedAt,
      pressedAt: Date.now(),
    });
    if (response.lapId) result.acknowledgements.push({ ...stamp(), lapId: response.lapId });
    if (method === 'race.handoff' && race.activeRunnerId)
      await action(nodes[rotation++ % 3], 'runners.setStatus', { id: race.activeRunnerId, status: 'waiting' });
  }
  async function chaosEvent(event) {
    const entry = { ...event, ...stamp() };
    result.events.push(entry);
    chaos = entry;
    const began = performance.now();
    const oldLeader = await leader();
    const followers = nodes.filter((n) => n !== oldLeader);
    const targets =
      event.kind === 'two-down'
        ? [oldLeader, followers[0]]
        : [event.kind === 'follower-freeze' || event.kind === 'laptop-out' ? followers[0] : oldLeader];
    entry.targets = targets.map((n) => n.name);
    entry.oldLeader = oldLeader.name;
    let restoreBegan = null;
    let observing = true;
    const observer = (async () => {
      await sleep(250);
      while (observing) {
        try {
          const next = await leader();
          if (next !== oldLeader && entry.newLeaderMs === undefined) {
            entry.newLeaderMs = performance.now() - began;
            entry.newLeader = next.name;
          }
          await action(next, 'runners.setStatus', { id: probe, status: 'registered' });
          if (entry.firstWriteMs === undefined) entry.firstWriteMs = performance.now() - began;
          if (restoreBegan !== null && entry.firstWriteAfterRestoreMs === undefined)
            entry.firstWriteAfterRestoreMs = performance.now() - restoreBegan;
        } catch {}
        await sleep(150);
      }
    })();
    try {
      const downAt = performance.now();
      for (const node of targets) {
        node.injectedUnavailable = true;
        node.interruptions++;
      }
      if (event.kind.includes('freeze')) targets.forEach((n) => n.child.kill('SIGSTOP'));
      else await Promise.all(targets.map((n) => kill(n, event.kind === 'leader-terminate' ? 'SIGTERM' : 'SIGKILL')));
      await sleep(
        event.kind === 'follower-freeze'
          ? 1000
          : event.kind === 'leader-freeze'
            ? 5000
            : event.kind === 'laptop-out'
              ? (event.outageRaceHours * 3600000) / config.ratio
              : 2000
      );
      if (event.kind === 'leader-freeze' || event.kind === 'leader-terminate') {
        const replacement = await until(async () => {
          const next = await leader();
          return next !== oldLeader && next;
        }, `${event.kind} new leader`);
        entry.newLeader = replacement.name;
        entry.newLeaderMs ??= performance.now() - began;
      }
      if (event.kind === 'two-down') {
        const survivor = nodes.find((n) => !targets.includes(n));
        try {
          await action(survivor, 'runners.setStatus', { id: probe, status: 'registered' });
          result.failures.push('Two-down window accepted a write without majority');
          entry.refused = false;
        } catch {
          entry.refused = true;
        }
      }
      entry.restoreAt = stamp();
      restoreBegan = performance.now();
      if (event.kind.includes('freeze'))
        targets.forEach((n) => {
          n.child.kill('SIGCONT');
          n.injectedUnavailable = false;
        });
      else await Promise.all(targets.map(start));
      await until(healthy, `${event.kind} catch-up`);
      const caughtUpAt = performance.now();
      await action(await leader(), 'runners.setStatus', { id: probe, status: 'registered' });
      const recoveredAt = performance.now();
      entry.firstWriteAfterRestoreMs ??= recoveredAt - restoreBegan;
      Object.assign(entry, recoveryTiming(began, downAt, restoreBegan, caughtUpAt, recoveredAt));
    } finally {
      observing = false;
      await observer;
      entry.end = stamp();
      chaos = null;
    }
  }
  const loops = [];
  async function screenPoll(node) {
    const state = await request(node, '/api/state');
    if (state.revision === node.historyRevision) return;
    const path = historyPath(node.historyCursor);
    const history = await request(node, path);
    if (
      typeof history.cursor !== 'string' ||
      (history.delta === true
        ? history.since !== node.historyCursor ||
          !Array.isArray(history.changes?.laps?.changed) ||
          !Array.isArray(history.changes?.events?.changed)
        : !Array.isArray(history.laps))
    ) {
      result.failures.push(`Invalid screen history response on ${node.name}`);
      node.historyCursor = undefined;
      return;
    }
    node.historyCursor = history.cursor;
    node.historyRevision = history.revision;
  }
  async function poll() {
    let tick = 0;
    while (!stopped) {
      await Promise.allSettled(
        nodes.flatMap((n) => [
          screenPoll(n),
          ...[
            '/api/cluster/status',
            ...(tick % 10 === 0 ? ['/api/history?scope=full', '/api/history?scope=recent'] : []),
          ].map((p) => request(n, p)),
        ])
      );
      tick++;
      await sleep(1000);
    }
  }
  const previousCpu = new Map();
  async function sample() {
    const hz = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    while (!stopped) {
      await Promise.all(
        nodes.map(async (node) => {
          try {
            const raw = await readFile(`/proc/${node.child.pid}/stat`, 'utf8');
            const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
            const ticks = Number(fields[11]) + Number(fields[12]),
              now = performance.now();
            const old = previousCpu.get(node.name);
            const memory = await readFile(`/proc/${node.child.pid}/status`, 'utf8');
            const sizes = await Promise.all(
              [node.db, node.db + '-wal'].map(async (p) => {
                try {
                  return (await stat(p)).size;
                } catch {
                  return 0;
                }
              })
            );
            result.resources.push({
              ...stamp(),
              node: node.name,
              pid: node.child.pid,
              rssBytes: Number(memory.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) * 1024,
              cpuPercent:
                old?.pid === node.child.pid ? ((ticks - old.ticks) / hz / ((now - old.now) / 1000)) * 100 : null,
              dbBytes: sizes[0],
              walBytes: sizes[1],
            });
            previousCpu.set(node.name, { ticks, now, pid: node.child.pid });
          } catch {}
        })
      );
      await sleep(5000);
    }
  }
  try {
    try {
      await stat(config.binary);
    } catch {
      if (config.binary !== resolve('native/target/release/apolloon-native'))
        throw new Error('Custom binary does not exist');
      const build = spawn(
        'cargo',
        ['build', '--release', '--locked', '--manifest-path', 'native/Cargo.toml', '--no-default-features'],
        { stdio: 'inherit' }
      );
      if ((await once(build, 'exit'))[0] !== 0) throw new Error('Release build failed');
    }
    for (const name of ['A', 'B', 'C']) {
      const server = createServer().listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address();
      await new Promise((done) => server.close(done));
      const node = {
        name,
        port,
        url: `http://127.0.0.1:${port}`,
        db: join(directory, `${name}.db`),
        injectedUnavailable: false,
        interruptions: 0,
      };
      nodes.push(node);
      await start(node);
    }
    for (const node of nodes.slice(1)) {
      await action(node, 'cluster.joinGroup', { url: nodes[0].url });
      await until(async () => (await status(node)).writable && !(await status(node)).busy, 'join');
    }
    await until(healthy, 'initial group');
    for (let i = 0; i < 150; i++)
      await action(nodes[i % 3], 'runners.create', {
        name: `Stress Runner ${i + 1}`,
        runnerNumber: String(i + 1),
        status: 'waiting',
        labels: i % 2 ? ['Dames'] : [],
        registrationDetails: { email: `runner${i}@example.test`, availableHours: ['20-21u', '21-22u'] },
      });
    probe = (await action(nodes[0], 'runners.create', { name: 'Stress recovery probe' })).id;
    if (!probe) throw new Error('Runner creation did not return an id');
    await until(healthy, 'setup replication');
    await timing('race.startNext');
    epoch = Date.now();
    loops.push(poll(), sample());
    const chaosLoop = (async () => {
      for (const event of plan.chaos) {
        await sleep(epoch + (event.raceSeconds * 1000) / config.ratio - Date.now());
        await chaosEvent(event);
      }
    })().catch((error) => {
      result.failures.push(`Chaos: ${error.stack}`);
    });
    loops.push(chaosLoop);
    for (const at of plan.laps) {
      await sleep(epoch + (at * 1000) / config.ratio - Date.now());
      const window = chaos;
      try {
        await timing('race.handoff');
      } catch (error) {
        if (!window && !chaos) result.failures.push(`Handoff outside chaos: ${error.message}`);
        result.events.push({ kind: 'write-attempt-error', ...stamp(), message: error.message });
      }
    }
    await sleep(epoch + (config.hours * 3600000) / config.ratio - Date.now());
    await chaosLoop;
    await until(healthy, 'pre-finish catch-up');
    await timing('race.finish');
    stopped = true;
    await Promise.all(loops);
    await until(healthy, 'final group');
    const histories = await Promise.all(nodes.map((n) => request(n, '/api/history?scope=full')));
    result.histories = histories;
    result.final = {
      statuses: await Promise.all(nodes.map(status)),
      lapIds: histories.map((h) => h.laps.map((l) => l.id).sort()),
    };
    if (!result.final.lapIds.every((ids) => JSON.stringify(ids) === JSON.stringify(result.final.lapIds[0])))
      result.failures.push('Nodes disagree on lap IDs/count');
    for (const ack of result.acknowledgements)
      if (histories.some((h) => h.laps.filter((l) => l.id === ack.lapId).length !== 1))
        result.failures.push(`Lost/duplicate acknowledged lap ${ack.lapId}`);
    if (new Set(result.acknowledgements.map((a) => a.lapId)).size !== result.acknowledgements.length)
      result.failures.push('Duplicate acknowledged lap IDs');
  } catch (error) {
    result.failures.push(error.stack);
  } finally {
    stopped = true;
    await Promise.allSettled(loops);
    await Promise.allSettled(nodes.map((n) => kill(n, 'SIGKILL')));
  }
  result.writeErrors = writeErrorSummary(result.requests);
  if (result.writeErrors.outsideChaos)
    result.failures.push(`${result.writeErrors.outsideChaos} write errors outside chaos`);
  result.metrics = {};
  for (const r of result.requests) {
    const bucket = r.phase === 'race' ? Math.floor(r.raceSeconds / 3600) : r.phase;
    for (const key of [r.endpoint, `${r.endpoint}@${bucket}`]) {
      const metric = (result.metrics[key] ??= { latencies: [], payloadBytes: [], encodedPayloadBytes: [], errors: 0 });
      metric.latencies.push(r.ms);
      if (r.bytes !== undefined) metric.payloadBytes.push(r.bytes);
      if (r.encodedBytes !== undefined) metric.encodedPayloadBytes.push(r.encodedBytes);
      if (r.error) metric.errors++;
    }
  }
  for (const [key, m] of Object.entries(result.metrics))
    result.metrics[key] = {
      latencyMs: distribution(m.latencies),
      payloadBytes: distribution(m.payloadBytes),
      encodedPayloadBytes: distribution(m.encodedPayloadBytes),
      errors: m.errors,
    };
  result.historyResponses = Object.fromEntries(
    ['full', 'recent', 'delta'].map((kind) => [kind, result.requests.filter((r) => r.historyKind === kind).length])
  );
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  result.growth = nodes.map((n) => {
    const rows = result.resources.filter((r) => r.node === n.name);
    const first = rows.filter((r) => r.raceSeconds < 3600),
      last = rows.filter((r) => r.raceSeconds >= (config.hours - 1) * 3600);
    const growth = { node: n.name, samples: rows.length };
    for (const field of ['rssBytes', 'cpuPercent']) {
      const valid = rows.filter((r) => r[field] !== null),
        xs = valid.map((r) => r.raceSeconds / 3600),
        ys = valid.map((r) => r[field]);
      const mx = mean(xs),
        my = mean(ys),
        denom = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
      growth[field] = {
        firstHour: mean(first.map((r) => r[field]).filter((v) => v !== null)),
        lastHour: mean(last.map((r) => r[field]).filter((v) => v !== null)),
        last: ys.at(-1) ?? null,
        peak: ys.length ? Math.max(...ys) : null,
        slopePerRaceHour: denom ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / denom : null,
      };
    }
    return growth;
  });
  let baseline = config.compare;
  if (!baseline) baseline = await latestRun(out);
  result.comparison = { baseline: baseline ?? null, rows: [] };
  if (baseline) {
    try {
      const before = JSON.parse(await readFile(baseline, 'utf8'));
      if (!isRunSummary(before)) throw new Error('Not a race stress run summary');
      const add = (key, old, current) =>
        result.comparison.rows.push({
          key,
          previous: old ?? null,
          current: current ?? null,
          delta: old != null && current != null ? current - old : null,
        });
      for (const endpoint of [
        '/api/state',
        '/api/history?scope=full',
        '/api/history?scope=recent',
        '/api/history?scope=full&since',
        '/api/cluster/status',
        '/api/action/race.handoff',
      ])
        for (const [field, p] of [
          ['latencyMs', 'p95'],
          ['payloadBytes', 'p50'],
          ['encodedPayloadBytes', 'p50'],
        ])
          add(
            `${endpoint} ${field} ${p}`,
            before.metrics?.[endpoint]?.[field]?.[p],
            result.metrics[endpoint]?.[field]?.[p]
          );
      for (const g of result.growth)
        for (const field of ['rssBytes', 'cpuPercent'])
          for (const p of ['peak', 'last'])
            add(`${g.node} ${field} ${p}`, before.growth?.find((v) => v.node === g.node)?.[field]?.[p], g[field][p]);
      for (const e of result.events.filter((e) => e.recoveryMs)) {
        const old = before.events.find((v) => v.kind === e.kind);
        const previous =
          old?.timingOrigin === 'restore'
            ? old.recoveryMs
            : old?.restoreAt
              ? old.recoveryMs - (old.restoreAt.wallMs - old.wallMs)
              : null;
        add(`${e.kind} recoveryMs (from restore)`, previous, e.recoveryMs);
      }
    } catch (error) {
      result.comparison.error = error.message;
      result.failures.push(`Comparison failed: ${error.message}`);
    }
  }
  result.passed = result.failures.length === 0;
  const file = join(out, `${id}.json`);
  const summary = compactSummary(result);
  await writeFile(join(directory, 'raw.json'), JSON.stringify(result) + '\n');
  await writeFile(
    file,
    JSON.stringify(summary, (_key, value) => (typeof value === 'number' ? Math.round(value * 1000) / 1000 : value)) +
      '\n'
  );
  console.log(
    `Race stress ${result.passed ? 'PASS' : 'FAIL'}: ${config.hours}h at ${config.ratio}x, seed ${config.seed}`
  );
  for (const [cause, counts] of Object.entries(result.writeErrors.byCause))
    console.log(`Write errors ${cause}: ${counts.total} (chaos/outside ${counts.insideChaos}/${counts.outsideChaos})`);
  console.log(
    `History responses full/recent/delta: ${result.historyResponses.full}/${result.historyResponses.recent}/${result.historyResponses.delta}`
  );
  for (const endpoint of [
    '/api/action/race.handoff',
    '/api/state',
    '/api/history?scope=full',
    '/api/history?scope=full&since',
  ]) {
    const metric = result.metrics[endpoint];
    const fmt = (value) => (value == null ? 'n/a' : value.toFixed(2));
    console.log(
      `${endpoint}: latency p50/p95/max ${fmt(metric?.latencyMs.p50)}/${fmt(metric?.latencyMs.p95)}/${fmt(metric?.latencyMs.max)}ms; peak payload decoded/encoded ${metric?.payloadBytes.max ?? 'n/a'}/${metric?.encodedPayloadBytes.max ?? 'n/a'} bytes`
    );
  }
  console.log(
    `Acknowledged laps: ${result.acknowledgements.length}/${plan.laps.length} scheduled; write errors chaos/outside: ${result.writeErrors.insideChaos}/${result.writeErrors.outsideChaos}`
  );
  for (const e of result.events.filter((e) => e.recoveryMs))
    console.log(
      `${e.kind}: outage ${Math.round(e.outageMs)}ms; caught up/recovered from restore ${Math.round(e.caughtUpMs)}/${Math.round(e.recoveryMs)}ms; new leader ${e.newLeaderMs === undefined ? 'n/a' : Math.round(e.newLeaderMs) + 'ms'}`
    );
  for (const g of result.growth)
    console.log(
      `${g.node}: RSS peak/last ${g.rssBytes.peak}/${g.rssBytes.last} bytes; CPU last ${g.cpuPercent.last?.toFixed(1) ?? 'n/a'}%`
    );
  if (result.comparison.rows.length) console.table(result.comparison.rows);
  for (const failure of result.failures) console.error(failure);
  console.log(`Run JSON: ${file}`);
  console.log(`Work artifacts: ${directory}`);
  if (!result.passed) process.exitCode = 1;
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
