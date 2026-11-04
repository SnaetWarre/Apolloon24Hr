import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { UpdateStatus } from '../electron/update-check.ts';
import {
  canMove,
  createUpdateFlow,
  NEXT_STATES,
  QUIT_TIMEOUT_MS,
  RACE_RUNNING,
  type Updater,
} from '../electron/update-flow.ts';

const NEWER = { version: '9.0.0', releaseDate: '2026-11-01T12:00:00Z' };

class FakeUpdater implements Updater {
  latest: { version: string; releaseDate: string } | null = NEWER;
  failCheck = false;
  failDownload = false;
  /** Set to hold the download open until it resolves. */
  downloading: Promise<void> | null = null;
  quitCalls = 0;
  throwOnQuit = false;

  async checkForUpdates() {
    if (this.failCheck) throw new Error('feed down');
    return this.latest ? { updateInfo: this.latest } : null;
  }

  async downloadUpdate() {
    await this.downloading;
    if (this.failDownload) throw new Error('disk full');
    return [];
  }

  quitAndInstall() {
    this.quitCalls += 1;
    if (this.throwOnQuit) throw new Error('installer missing');
  }
}

function setUp({
  inApp = true,
  release = { state: 'current', checkedAt: 1 } as UpdateStatus,
  raceActive = (): boolean => false,
  makeBackup = async (): Promise<void> => {},
} = {}) {
  const updater = new FakeUpdater();
  const sent: string[] = [];
  const notes: string[] = [];
  const flow = createUpdateFlow({
    currentVersion: '5.3.1',
    inApp,
    updater: async () => updater,
    checkRelease: async () => release,
    log: () => {},
    send: (status) => sent.push(status.state),
    isRaceActive: raceActive,
    makeBackup,
    beforeInstall: (version) => notes.push(version),
  });
  return { flow, updater, sent, notes };
}

/** Checks, downloads and ends at ready. */
async function readyFlow(options?: Parameters<typeof setUp>[0]) {
  const setup = setUp(options);
  await setup.flow.check();
  await settle(setup.flow, 'ready');
  return setup;
}

async function settle(flow: ReturnType<typeof setUp>['flow'], state: UpdateStatus['state']) {
  for (let turn = 0; turn < 20 && flow.status().state !== state; turn += 1) await Promise.resolve();
  assert.equal(flow.status().state, state);
}

function mockTimers(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setImmediate'] });
  return (ms: number) => t.mock.timers.tick(ms);
}

test('the table names every state and only these moves', () => {
  assert.deepEqual(Object.keys(NEXT_STATES).sort(), [
    'available',
    'checking',
    'current',
    'downloading',
    'idle',
    'installing',
    'ready',
    'unreachable',
  ]);
  assert.ok(canMove('idle', 'checking'));
  assert.ok(canMove('installing', 'ready'));
  assert.ok(!canMove('idle', 'installing'));
  assert.ok(!canMove('ready', 'checking'));
  assert.ok(!canMove('installing', 'checking'));
  assert.ok(!canMove('current', 'ready'));
});

test('before any check the status is idle, and a check from there runs (stuck case 1)', async () => {
  const { flow, sent } = setUp({ inApp: false });
  assert.deepEqual(flow.status(), { state: 'idle', checkedAt: null });
  assert.equal((await flow.check()).state, 'current');
  assert.deepEqual(sent, ['checking', 'current']);
});

test('the updater finds no newer version: current', async () => {
  const { flow, updater, sent } = setUp();
  updater.latest = { version: '5.3.1', releaseDate: '' };
  assert.equal((await flow.check()).state, 'current');
  assert.deepEqual(sent, ['checking', 'current']);
});

test('without the updater the release page decides: available, then unreachable keeps it', async () => {
  const update = { version: '9.0.0', pageUrl: 'p', downloadUrl: null, publishedAt: null };
  const available: UpdateStatus = { state: 'available', checkedAt: 1, update, problem: null };
  const setup = setUp({ inApp: false, release: available });
  assert.equal((await setup.flow.check()).state, 'available');

  const offline = setUp({ inApp: false, release: { state: 'unreachable', checkedAt: 2 } });
  assert.equal((await offline.flow.check()).state, 'unreachable');
  assert.equal((await offline.flow.check()).state, 'unreachable');
});

test('an updater check that fails falls back to the release page', async () => {
  const { flow, updater } = setUp({ release: { state: 'unreachable', checkedAt: 3 } });
  updater.failCheck = true;
  assert.equal((await flow.check()).state, 'unreachable');
});

test('a newer version downloads with progress and ends ready', async () => {
  const { flow, updater, sent } = setUp();
  let finish = () => {};
  updater.downloading = new Promise((resolve) => (finish = resolve));
  await flow.check();
  assert.equal(flow.status().state, 'downloading');
  flow.progress(41.7);
  flow.progress(41.9);
  const status = flow.status();
  assert.ok(status.state === 'downloading' && status.percent === 41);
  finish();
  await settle(flow, 'ready');
  assert.deepEqual(sent, ['checking', 'downloading', 'downloading', 'ready']);
});

test('a failed download goes back to available with a problem', async () => {
  const setup = setUp();
  setup.updater.failDownload = true;
  await setup.flow.check();
  await settle(setup.flow, 'available');
  const status = setup.flow.status();
  assert.ok(status.state === 'available' && status.problem);
});

test('no new check while downloading, ready or installing', async (t) => {
  const { flow, sent } = await readyFlow();
  const before = sent.length;
  assert.equal((await flow.check()).state, 'ready');
  mockTimers(t);
  await flow.install();
  assert.equal((await flow.check()).state, 'installing');
  assert.equal(sent.length, before + 1);
});

test('install: ready, installing, then the updater closes the app', async (t) => {
  const tick = mockTimers(t);
  const { flow, updater, notes } = await readyFlow();
  assert.equal(await flow.install(), null);
  assert.equal(flow.status().state, 'installing');
  tick(0);
  assert.equal(updater.quitCalls, 1);
  assert.deepEqual(notes, ['9.0.0']);
});

test('a failed backup goes back to ready and says why', async () => {
  const { flow } = await readyFlow({
    makeBackup: async () => {
      throw new Error('schijf vol');
    },
  });
  assert.match((await flow.install()) ?? '', /backup vooraf mislukte.*schijf vol/);
  assert.equal(flow.status().state, 'ready');
});

test('a race that starts during the backup stops the install', async () => {
  let racing = false;
  const { flow, updater } = await readyFlow({
    raceActive: () => racing,
    makeBackup: async () => {
      racing = true;
    },
  });
  assert.equal(await flow.install(), RACE_RUNNING);
  assert.equal(flow.status().state, 'ready');
  assert.equal(updater.quitCalls, 0);
});

test('an updater error after quitAndInstall goes back to ready with the reason (stuck case 2)', async (t) => {
  const tick = mockTimers(t);
  const { flow, updater } = await readyFlow();
  await flow.install();
  tick(0);
  flow.updaterError(new Error("No update filepath provided, can't quit and install"));
  const status = flow.status();
  assert.ok(status.state === 'ready');
  assert.match(status.problem ?? '', /niet geïnstalleerd: No update filepath/);
  // The button works again.
  assert.equal(await flow.install(), null);
  tick(0);
  assert.equal(updater.quitCalls, 2);
});

test('quitAndInstall that throws goes back to ready', async (t) => {
  const tick = mockTimers(t);
  const { flow, updater } = await readyFlow();
  updater.throwOnQuit = true;
  await flow.install();
  tick(0);
  const status = flow.status();
  assert.ok(status.state === 'ready' && status.problem?.includes('installer missing'));
});

test('an app that stays open after quitAndInstall goes back to ready (stuck case 2, "Blijven")', async (t) => {
  const tick = mockTimers(t);
  const { flow } = await readyFlow();
  await flow.install();
  tick(0);
  tick(QUIT_TIMEOUT_MS - 1);
  assert.equal(flow.status().state, 'installing');
  tick(1);
  const status = flow.status();
  assert.ok(status.state === 'ready' && status.problem?.startsWith('Apolloon sloot niet af'));
});

test('updater errors outside installing leave the status alone', async () => {
  const { flow } = await readyFlow();
  flow.updaterError(new Error('Cannot check for updates'));
  const status = flow.status();
  assert.ok(status.state === 'ready' && status.problem === null);
});
