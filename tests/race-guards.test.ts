import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { ReplicationOperation } from '../server/db.ts';

// NB: géén statische imports van servermodules hier: die zouden vóór
// DATA_PATH gezet is al evalueren en de echte data/app.db gebruiken.
// Alles gaat via dynamische imports ná het zetten van de env (zelfde patroon
// als backup-policy.test.ts).

const dataPath = path.resolve(`.tmp-test-race-guards-${process.pid}`);
process.env.DATA_PATH = dataPath;
process.env.NODE_ENV = 'test';
process.env.BACKUP_ENABLED = 'false';
process.env.CLUSTER_ENABLED = 'false';

async function loadDb() {
  return import('../server/db.ts');
}

async function loadGate() {
  const queue = await import('../server/db/queue.ts');
  return queue.runnerStatusChangeError;
}

// ---------------------------------------------------------------------------
// Poort rond live-race statuswijzigingen (Telsysteem 1 vs timing)
// ---------------------------------------------------------------------------

const LOCAL = 'host-timing';
const REMOTE = 'host-t1';

test('actieve loper aanpassen mag alleen op de timinglaptop', async () => {
  const runnerStatusChangeError = await loadGate();
  const blocked = runnerStatusChangeError({
    runnerId: 'runner-active',
    status: 'waiting',
    activeRunnerId: 'runner-active',
    raceFinishedAt: null,
    controllerHostId: LOCAL,
    localHostId: REMOTE,
  });
  assert.match(blocked || '', /timinglaptop/);

  const allowedLocal = runnerStatusChangeError({
    runnerId: 'runner-active',
    status: 'waiting',
    activeRunnerId: 'runner-active',
    raceFinishedAt: null,
    controllerHostId: LOCAL,
    localHostId: LOCAL,
  });
  assert.equal(allowedLocal, null);
});

test('zonder toegewezen controller blijft alles werken (opstart)', async () => {
  const runnerStatusChangeError = await loadGate();
  const result = runnerStatusChangeError({
    runnerId: 'runner-active',
    status: 'waiting',
    activeRunnerId: 'runner-active',
    raceFinishedAt: null,
    controllerHostId: null,
    localHostId: REMOTE,
  });
  assert.equal(result, null);
});

test('handmatig starten op een andere laptop wordt geweigerd', async () => {
  const runnerStatusChangeError = await loadGate();
  const blocked = runnerStatusChangeError({
    runnerId: 'runner-x',
    status: 'running',
    activeRunnerId: null,
    raceFinishedAt: null,
    controllerHostId: LOCAL,
    localHostId: REMOTE,
  });
  assert.match(blocked || '', /timinglaptop/);
});

test('gef finishte race heropenen kan alleen op de timinglaptop', async () => {
  const runnerStatusChangeError = await loadGate();
  const blocked = runnerStatusChangeError({
    runnerId: 'runner-x',
    status: 'running',
    activeRunnerId: null,
    raceFinishedAt: Date.now(),
    controllerHostId: LOCAL,
    localHostId: REMOTE,
  });
  assert.match(blocked || '', /gefinisht/);

  const allowedLocal = runnerStatusChangeError({
    runnerId: 'runner-x',
    status: 'running',
    activeRunnerId: null,
    raceFinishedAt: Date.now(),
    controllerHostId: LOCAL,
    localHostId: LOCAL,
  });
  assert.equal(allowedLocal, null);
});

test('gewoon wachtrijwerk wordt nooit geblokkeerd', async () => {
  const runnerStatusChangeError = await loadGate();
  const result = runnerStatusChangeError({
    runnerId: 'runner-y',
    status: 'waiting',
    activeRunnerId: 'runner-active',
    raceFinishedAt: null,
    controllerHostId: LOCAL,
    localHostId: REMOTE,
  });
  assert.equal(result, null);
});

test('dezelfde actieve loper opnieuw op running zetten blijft idempotent', async () => {
  const runnerStatusChangeError = await loadGate();
  const result = runnerStatusChangeError({
    runnerId: 'runner-active',
    status: 'running',
    activeRunnerId: 'runner-active',
    raceFinishedAt: null,
    controllerHostId: LOCAL,
    localHostId: REMOTE,
  });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Quarantaine voor foute replicatie-operaties (dead letters)
// ---------------------------------------------------------------------------

function checksumOf(op: Omit<ReplicationOperation, 'checksum' | 'status' | 'appliedAt'>): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        id: op.id,
        clusterId: op.clusterId,
        originHostId: op.originHostId,
        originSeq: op.originSeq,
        hlcWallMs: op.hlcWallMs,
        hlcCounter: op.hlcCounter,
        type: op.type,
        payload: op.payload,
        statements: op.statements,
        result: op.result,
        raceBaseKey: op.raceBaseKey,
        createdAt: op.createdAt,
      })
    )
    .digest('hex');
}

test('een foute operatie gaat in quarantaine zonder de geldige te blokkeren', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    const identity = db.ensureReplicationIdentity();
    const now = Date.now();
    const runnerId = crypto.randomUUID();
    const validBase = {
      id: crypto.randomUUID(),
      clusterId: identity.clusterId,
      originHostId: 'ghost-laptop',
      originSeq: 1,
      hlcWallMs: now,
      hlcCounter: 0,
      type: 'test.quarantine-runner',
      payload: null,
      statements: [
        {
          sql: 'INSERT INTO runners (id, runner_number, name, registration_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          params: [runnerId, 'QUAR-1', 'Quarantaine Test', 'manual', now, now],
        },
      ],
      result: null,
      raceBaseKey: null,
      createdAt: now,
    };
    const valid: ReplicationOperation = {
      ...validBase,
      status: 'accepted',
      checksum: checksumOf(validBase),
      appliedAt: now,
    };
    const poisoned: ReplicationOperation = {
      ...valid,
      id: crypto.randomUUID(),
      originSeq: 2,
      checksum: '0'.repeat(64),
    };

    // Geen throw meer (vroeger HTTP 500 + eeuwige wedge), geldige wordt toegepast.
    const result = db.applyRemoteReplicationOperations([valid, poisoned]);
    assert.equal(result.applied, 1);
    assert.equal(result.quarantined, 1);
    assert.equal(result.conflicts, 0);
    assert.ok(db.getRunnerById(runnerId));
    assert.equal(db.getDeadLetterCount(), 1);

    // Opnieuw aanbieden: geen throw, geen dubbele quarantaine-telling in de lijst.
    const retry = db.applyRemoteReplicationOperations([poisoned]);
    assert.equal(retry.applied, 0);
    assert.equal(retry.quarantined, 1);
    assert.equal(db.getDeadLetterCount(), 1);
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});

test('een volgorde-gat breekt de batch nog steeds af (geen stille dataverlies)', async () => {
  fs.rmSync(dataPath, { recursive: true, force: true });
  const db = await import('../server/db.ts');
  try {
    await db.initDb();
    const identity = db.ensureReplicationIdentity();
    const now = Date.now();
    const gapBase = {
      id: crypto.randomUUID(),
      clusterId: identity.clusterId,
      originHostId: 'gap-laptop',
      originSeq: 2,
      hlcWallMs: now,
      hlcCounter: 0,
      type: 'test.gap',
      payload: null,
      statements: [],
      result: null,
      raceBaseKey: null,
      createdAt: now,
    };
    const gapOp: ReplicationOperation = {
      ...gapBase,
      status: 'accepted',
      checksum: checksumOf(gapBase),
      appliedAt: now,
    };
    assert.throws(() => db.applyRemoteReplicationOperations([gapOp]), /replication gap/);
    assert.equal(db.getDeadLetterCount(), 0);
  } finally {
    db.closeDb();
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
});
