import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apolloon-idle-benchmark-'));
process.env.DATA_PATH = fixtureDirectory;
process.env.NODE_ENV = 'production';
const db = await import('../server/db.js');
const operationCount = 100_000;
const originCount = 5;
const iterationsPerSample = 25;
const warmupIterations = 5;
const measuredSamples = 5;

try {
  await db.initDb();
  const identity = db.ensureReplicationIdentity();
  db.getReplicationCheckpoint();
  db.closeDb();
  const fixtureDb = new Database(path.join(fixtureDirectory, 'data', 'app.db'));
  const insertOperation = fixtureDb.prepare(`INSERT INTO replication_operations
    (id, cluster_id, origin_host_id, origin_seq, hlc_wall_ms, hlc_counter, type,
     payload_json, statements_json, result_json, race_base_key, status, checksum, created_at, applied_at)
    VALUES (?, ?, ?, ?, ?, 0, 'benchmark.noop', 'null', '[]', 'null', ?, 'accepted', ?, ?, ?)`);
  fixtureDb.transaction(() => {
    for (let operationIndex = 0; operationIndex < operationCount; operationIndex += 1) {
      const operationId = `operation-${operationIndex}`;
      const originHostId = `origin-${operationIndex % originCount}`;
      const originSeq = Math.floor(operationIndex / originCount) + 1;
      const timestamp = 1_700_000_000_000 + operationIndex;
      const raceBaseKey = `race-${operationIndex}`;
      const checksum = crypto.createHash('sha256').update(JSON.stringify({
        id: operationId, clusterId: identity.clusterId, originHostId, originSeq,
        hlcWallMs: timestamp, hlcCounter: 0, type: 'benchmark.noop', payload: null,
        statements: [], result: null, raceBaseKey, createdAt: timestamp,
      })).digest('hex');
      insertOperation.run(operationId, identity.clusterId, originHostId, originSeq,
        timestamp, raceBaseKey, checksum, timestamp, timestamp);
    }
  })();
  fixtureDb.close();
  await db.initDb();
  const expectedVector = Object.fromEntries(Array.from({ length: originCount },
    (_, originIndex) => [`origin-${originIndex}`, operationCount / originCount]));
  assert.deepEqual(db.getReplicationVector(), expectedVector);
  assert.deepEqual(db.getReplicationOperationsMissing(expectedVector), []);
  assert.equal(db.getReplicationOperationsMissing({ ...expectedVector, 'origin-0': 19_999 })[0].originSeq, 20_000);
  db.acknowledgeReplicationVector('benchmark-peer', expectedVector);

  const scenarios = {
    vector: () => { db.getReplicationVector(); },
    caughtUpDelta: () => { db.getReplicationOperationsMissing(expectedVector); },
    emptyBatch: () => { db.applyRemoteReplicationOperations([]); },
    unchangedAcknowledgement: () => { db.acknowledgeReplicationVector('benchmark-peer', expectedVector); },
  };
  const measurements: Record<string, { wallMsPerCall: number[]; cpuMsPerCall: number[] }> = {};
  for (const [scenarioName, runScenario] of Object.entries(scenarios)) {
    for (let iteration = 0; iteration < warmupIterations; iteration += 1) runScenario();
    const wallMsPerCall: number[] = [];
    const cpuMsPerCall: number[] = [];
    for (let sample = 0; sample < measuredSamples; sample += 1) {
      const cpuBefore = process.cpuUsage();
      const startedAt = performance.now();
      for (let iteration = 0; iteration < iterationsPerSample; iteration += 1) runScenario();
      wallMsPerCall.push((performance.now() - startedAt) / iterationsPerSample);
      const cpuUsed = process.cpuUsage(cpuBefore);
      cpuMsPerCall.push((cpuUsed.user + cpuUsed.system) / 1_000 / iterationsPerSample);
    }
    measurements[scenarioName] = { wallMsPerCall, cpuMsPerCall };
  }
  assert.deepEqual(db.getReplicationVector(), expectedVector);
  assert.deepEqual(db.applyRemoteReplicationOperations([]), { applied: 0, duplicates: 0, conflicts: 0 });
  console.log(JSON.stringify({
    environment: { node: process.version, platform: `${os.type()} ${os.release()}`, cpu: os.cpus()[0].model },
    workload: { operationCount, originCount, iterationsPerSample, warmupIterations, measuredSamples, synchronous: 'FULL' },
    measurements,
  }, null, 2));
} finally {
  db.closeDb();
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
}
