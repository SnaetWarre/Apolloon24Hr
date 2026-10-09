import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import WebSocket from 'ws';
import { PEER_SOCKET_PATH } from '../server/peer-socket.ts';
import type { AppRouter } from '../server/router.ts';
import type { AppSnapshot, ClusterStatus, LiveAppSnapshot, RaceHistory } from '../shared/schemas.ts';

/** Laptops in these tests announce themselves on loopback, on a port of their own per test run. */
const discoveryPort = 20_000 + (process.pid % 20_000);

type RunningServer = {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  dataPath: string;
  name?: string;
  output: () => string;
  /** Set when the test stops it; any other exit is reported with the server's output. */
  stopping: boolean;
};

test('standalone mode stays writable and does not expose replication', { timeout: 15_000 }, async () => {
  const root = testRoot('standalone');
  const server = await startServer({
    port: await freePort(),
    dataPath: root,
    clusterEnabled: false,
  });
  try {
    const runner = await client(server).runners.create.mutate({ name: 'Solo runner', runnerNumber: 'SOLO-1' });
    assert.equal(runner.runnerNumber, 'SOLO-1');
    const status = await fetchStatus(server);
    assert.equal(status.enabled, false);
    assert.equal(status.role, 'leader');
    assert.equal(status.state, 'solo');
    assert.equal(status.writable, true);

    const health = (await (await fetch(`${server.baseUrl}/api/health`)).json()) as {
      ok: boolean;
      releaseId: string | null;
      database: { ready: boolean; schemaVersion: number };
    };
    assert.equal(health.ok, true);
    assert.equal(health.releaseId, 'e2e-test-release');
    assert.equal(health.database.ready, true);
    assert.deepEqual((health as unknown as { race: unknown }).race, { active: false });

    assert.equal(await peerSocketStatus(server, {}), 404);
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a manual backup can be downloaded as a SQLite file', { timeout: 15_000 }, async () => {
  const root = testRoot('backup');
  const server = await startServer({ port: await freePort(), dataPath: root, clusterEnabled: false });
  try {
    await client(server).runners.create.mutate({ name: 'Backup runner', runnerNumber: 'BACKUP-1' });
    const record = await client(server).backups.create.mutate();
    const download = await fetch(`${server.baseUrl}/api/backups/latest`);
    assert.equal(download.ok, true, server.output());
    assert.match(download.headers.get('content-disposition') ?? '', new RegExp(record.fileName));
    const contents = Buffer.from(await download.arrayBuffer());
    assert.equal(contents.subarray(0, 16).toString('binary'), 'SQLite format 3\u0000');
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'restoring a backup on one laptop puts the whole group back, after a safety backup, and says who did it',
  { timeout: 40_000 },
  async () => {
    const root = testRoot('restore');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const leader = (await leaderOf(servers))!;
      const [follower, other] = servers.filter((server) => server !== leader);
      const kept = await client(leader).runners.create.mutate({ name: 'Kept', runnerNumber: 'R-1', status: 'waiting' });
      await client(leader).runners.create.mutate({ name: 'Also kept', runnerNumber: 'R-2', status: 'waiting' });
      const startedAt = Date.now() - 4_000;
      await client(leader).race.startNext.mutate({ activeRunnerId: null, activeStartedAt: null, pressedAt: startedAt });
      await waitForSameState(leader, follower);
      await waitForSameState(leader, other);
      const backup = await client(follower).backups.create.mutate();

      // What goes wrong after the backup: a lap and a runner removed by mistake.
      await client(other).race.handoff.mutate({
        activeRunnerId: kept.id,
        activeStartedAt: startedAt,
        pressedAt: Date.now(),
      });
      const lost = await client(other).runners.create.mutate({ name: 'Added later', runnerNumber: 'R-3' });
      await client(other).runners.delete.mutate({ id: lost.id });
      assert.equal((await fetchState(leader)).laps.length, 1);

      const preview = await client(follower).backups.preview.query({ fileName: backup.fileName });
      assert.deepEqual([preview.runners, preview.laps, preview.raceStartedAt], [2, 0, startedAt]);

      // Restored on a laptop that does not lead: the rows travel to the leader as one write.
      const restored = await client(follower).backups.restore.mutate({ fileName: backup.fileName });
      assert.deepEqual([restored.runners, restored.laps], [2, 0]);
      assert.match(restored.safetyBackup, /pre-restore/);
      assert.equal(restored.safetyHostUrl, leader.baseUrl);
      assert.ok(
        (await client(leader).backups.list.query()).some((record) => record.fileName === restored.safetyBackup),
        'the state before the restore is kept'
      );
      for (const server of servers) {
        await waitForSameState(follower, server);
        const state = await fetchState(server);
        assert.deepEqual(state.runners.map((runner) => runner.name).sort(), ['Also kept', 'Kept']);
        assert.equal(state.laps.length, 0);
        assert.equal(state.race.activeRunnerId, kept.id);
        assert.equal(state.race.activeStartedAt, startedAt);
      }

      // Every laptop lists the same activity, the restore included, with where it came from.
      const activity = await client(other).activity.list.query({});
      assert.match(activity[0]?.summary ?? '', /^Backup van .+ teruggezet \(2 lopers, 0 rondes\)$/);
      assert.match(activity[0]?.origin ?? '', /laptop/);
      const summaries = activity.map((entry) => entry.summary);
      assert.ok(summaries.includes('#R-3 Added later verwijderd'), summaries.join('\n'));
      assert.ok(summaries.includes('Wedstrijd gestart'));
      assert.ok(!summaries.some((summary) => /wissel/i.test(summary)), 'handoffs are the laps, not activity');
      assert.deepEqual(await client(leader).activity.list.query({}), activity);
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'a restore from a stale follower can be undone using the leader’s safety backup',
  { timeout: 40_000 },
  async () => {
    const root = testRoot('restore-stale');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const leader = (await leaderOf(servers))!;
      const follower = servers.find((server) => server !== leader)!;
      const kept = await client(leader).runners.create.mutate({ name: 'Kept', runnerNumber: 'KEEP' });
      await waitForSameState(leader, follower);
      const backup = await client(follower).backups.create.mutate();
      await isolate(follower, true);
      const latest = await client(leader).runners.create.mutate({ name: 'Latest committed', runnerNumber: 'LATEST' });
      await client(leader).settings.updatePublicRecordMode.mutate({ publicRecordMode: 'off' });
      assert.deepEqual(
        (await fetchState(follower)).runners.map((runner) => runner.id),
        [kept.id]
      );

      // The restore waits for the cable to return. Its safety copy must not use this stale data.
      const restoring = client(follower).backups.restore.mutate({ fileName: backup.fileName });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await isolate(follower, false);
      const restored = await restoring;
      const safetyHost = servers.find((server) => server.baseUrl === restored.safetyHostUrl)!;
      assert.ok(safetyHost);
      const preview = await client(safetyHost).backups.preview.query({ fileName: restored.safetyBackup });
      assert.equal(preview.runners, 2, 'the safety copy includes the write the follower had not received');
      for (const server of servers) {
        await waitForSameState(leader, server);
        assert.equal((await fetchState(server)).settings.publicRecordMode, 'day');
      }

      await client(safetyHost).backups.restore.mutate({ fileName: restored.safetyBackup });
      for (const server of servers) {
        await waitForSameState(safetyHost, server);
        const state = await fetchState(server);
        assert.deepEqual(state.runners.map((runner) => runner.id).sort(), [kept.id, latest.id].sort());
        assert.equal(state.settings.publicRecordMode, 'off');
      }
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('writes during safety-backup verification are preserved before restoring', { timeout: 20_000 }, async () => {
  const root = testRoot('restore-concurrent');
  const server = await startServer({ port: await freePort(), dataPath: root, clusterEnabled: false });
  try {
    await client(server).runners.create.mutate({ name: 'Original', runnerNumber: 'ORIGINAL' });
    const backup = await client(server).backups.create.mutate();
    const restoring = client(server).backups.restore.mutate({ fileName: backup.fileName });
    // The online snapshot starts before its worker checks finish. Add a write in that gap.
    await waitFor(
      async () => {
        return (await fetchStatus(server)).backup.inProgress;
      },
      8_000,
      1
    );
    await client(server).runners.create.mutate({ name: 'During backup', runnerNumber: 'DURING' });
    const restored = await restoring;
    const preview = await client(server).backups.preview.query({ fileName: restored.safetyBackup });
    assert.equal(preview.runners, 2, 'the final safety copy includes the concurrent write');
    await client(server).backups.restore.mutate({ fileName: restored.safetyBackup });
    assert.deepEqual((await fetchState(server)).runners.map((runner) => runner.name).sort(), [
      'During backup',
      'Original',
    ]);
  } catch (error) {
    throw withServerOutput(error, server);
  } finally {
    await stopServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('three laptops form one group, every laptop writes, and each holds everything', { timeout: 40_000 }, async () => {
  const root = testRoot('group');
  const servers: RunningServer[] = [];
  try {
    const first = await startServer({ port: await freePort(), dataPath: path.join(root, 'first'), name: 'LAPTOP-EEN' });
    servers.push(first);
    await client(first).runners.create.mutate({ name: 'Before the group', runnerNumber: 'A-1' });
    await client(first).runners.create.mutate({ name: 'Also before the group', runnerNumber: 'A-2' });
    const second = await startServer({
      port: await freePort(),
      dataPath: path.join(root, 'second'),
      name: 'LAPTOP-TWEE',
    });
    servers.push(second);
    await client(second).runners.create.mutate({ name: 'Replaced by the join', runnerNumber: 'B-1' });
    // A laptop on its own lists the laptops it could join by their computer name, without anyone typing an address.
    await waitFor(async () =>
      (await fetchStatus(second)).nearby.some(
        (group) =>
          group.url === first.baseUrl && group.name === 'LAPTOP-EEN' && group.runners === 2 && group.link === 'join'
      )
    );
    // The laptop with more runners keeps them: Koppelen there sends the operator to the other laptop.
    await assert.rejects(client(first).cluster.join.mutate({ url: second.baseUrl }), /Druk op Koppelen op/);
    // A laptop of an older version announces itself without a name; it is still listed, by its address.
    const oldLaptop = 'http://127.0.0.1:1';
    await waitFor(async () => {
      await announceWithoutName(oldLaptop);
      return (await fetchStatus(second)).nearby.some((group) => group.url === oldLaptop && group.name === null);
    });
    const joined = await join(second, first);
    assert.match(joined.backupFile ?? '', /pre-join/);
    const third = await startServer({
      port: await freePort(),
      dataPath: path.join(root, 'third'),
      name: 'LAPTOP-DRIE',
    });
    servers.push(third);
    await waitFor(async () => (await fetchStatus(third)).nearby.some((group) => group.laptops === 2));
    assert.equal(
      (await fetchStatus(third)).nearby.filter((group) => group.url !== oldLaptop).length,
      1,
      'the two linked laptops are listed as one group'
    );
    // Joining through a laptop that does not lead works too.
    await join(third, second);
    await waitFor(async () => (await fetchStatus(first)).state === 'healthy', 10_000);

    for (const [index, server] of servers.entries()) {
      await client(server).runners.create.mutate({ name: `Written on laptop ${index}`, runnerNumber: `W-${index}` });
      // A write returns once a majority stored it, and the laptop it was made on shows it at once.
      assert.ok((await fetchState(server)).runners.some((runner) => runner.name === `Written on laptop ${index}`));
      const holders = await Promise.all(
        servers.map(async (other) =>
          (await fetchState(other)).runners.some((runner) => runner.name === `Written on laptop ${index}`)
        )
      );
      assert.ok(holders.filter(Boolean).length >= 2, `only ${holders.filter(Boolean).length} laptop holds the write`);
    }
    await waitForSameState(first, second);
    await waitForSameState(first, third);
    assert.deepEqual((await fetchState(third)).runners.map((runner) => runner.name).sort(), [
      'Also before the group',
      'Before the group',
      'Written on laptop 0',
      'Written on laptop 1',
      'Written on laptop 2',
    ]);
    const status = await fetchStatus(third);
    assert.equal(status.members.length, 3);
    assert.equal(status.majority, 2);
    assert.deepEqual(status.memberUrls.sort(), [first.baseUrl, second.baseUrl].sort());
    assert.equal(status.hostName, 'LAPTOP-DRIE');
    assert.deepEqual(Object.fromEntries(status.members.map((member) => [member.url, member.name])), {
      [first.baseUrl]: 'LAPTOP-EEN',
      [second.baseUrl]: 'LAPTOP-TWEE',
      [third.baseUrl]: 'LAPTOP-DRIE',
    });
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'when the leading laptop dies mid-race, a lap pressed during the takeover counts once, at the press',
  { timeout: 40_000 },
  async () => {
    const root = testRoot('leader-dies');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const leader = await leaderOf(servers);
      assert.ok(leader, 'a leader was chosen');
      const [timing, other] = servers.filter((server) => server !== leader);

      const first = await client(timing).runners.create.mutate({
        name: 'First',
        runnerNumber: 'T-1',
        status: 'waiting',
      });
      await client(other).runners.create.mutate({ name: 'Second', runnerNumber: 'T-2', status: 'waiting' });
      const startedAt = Date.now() - 4_000;
      await client(timing).race.startNext.mutate({ activeRunnerId: null, activeStartedAt: null, pressedAt: startedAt });
      await waitForSameState(leader, timing);

      await killServer(leader);
      const pressedAt = Date.now();
      await client(timing).race.handoff.mutate({
        activeRunnerId: first.id,
        activeStartedAt: startedAt,
        pressedAt,
        measuredDurationMs: pressedAt - startedAt,
      });

      const state = await fetchState(timing);
      assert.equal(state.laps.length, 1, 'the lap is stored once');
      assert.equal(state.laps[0]?.startedAt, startedAt);
      assert.equal(state.laps[0]?.durationMs, pressedAt - startedAt, 'the lap ends at the key press');
      await waitForSameState(timing, other);
      const survivor = await fetchStatus(timing);
      assert.equal(survivor.state, 'degraded');
      assert.equal(survivor.members.filter((member) => !member.reachable).length, 1);

      // The laptop comes back and catches up by itself.
      const restarted = await startServer({ port: leader.port, dataPath: leader.dataPath });
      servers[servers.indexOf(leader)] = restarted;
      await waitForSameState(timing, restarted, 10_000);
      await waitFor(async () => (await fetchStatus(timing)).state === 'healthy', 10_000);
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('a lap fixed in Beheer › Rondes on any laptop is fixed on every laptop', { timeout: 40_000 }, async () => {
  const root = testRoot('lap-fixes');
  const servers: RunningServer[] = [];
  try {
    await startGroup(root, servers);
    const [a, b, c] = servers;
    const first = await client(a).runners.create.mutate({ name: 'First', runnerNumber: 'R-1', status: 'waiting' });
    const second = await client(a).runners.create.mutate({ name: 'Second', runnerNumber: 'R-2', status: 'waiting' });
    const startedAt = Date.now() - 6_000;
    await client(a).race.startNext.mutate({ activeRunnerId: null, activeStartedAt: null, pressedAt: startedAt });
    const handoffAt = startedAt + 2_000;
    await client(a).race.handoff.mutate({ activeRunnerId: first.id, activeStartedAt: startedAt, pressedAt: handoffAt });
    await client(a).race.handoff.mutate({
      activeRunnerId: second.id,
      activeStartedAt: handoffAt,
      pressedAt: handoffAt + 3_000,
    });
    const [secondLap, firstLap] = (await fetchState(a)).laps;
    assert.equal(secondLap.runnerId, second.id);

    // Each fix is made on another laptop; every laptop ends up with the same laps.
    await client(b).laps.move.mutate({ lapId: secondLap.id, runnerId: first.id });
    await client(c).laps.split.mutate({ lapId: firstLap.id, runnerId: second.id });
    const split = (await fetchState(c)).laps.find((lap) => lap.runnerId === second.id);
    assert.ok(split);
    await client(a).laps.delete.mutate({ lapId: split.id });
    for (const copy of [b, c]) await waitForSameState(a, copy);

    const laps = (await fetchState(b)).laps;
    assert.deepEqual(
      laps.map((lap) => [lap.runnerId, lap.lapNumber, lap.durationMs]),
      [
        [first.id, 2, 3_000],
        [first.id, 1, 1_000],
      ]
    );
    const summaries = (await client(c).activity.list.query({ limit: 20, before: null })).map((entry) => entry.summary);
    assert.ok(summaries.some((summary) => /^Ronde 1 van #R-2 Second .* naar #R-1 First verplaatst$/.test(summary)));
    assert.ok(summaries.some((summary) => summary.endsWith('gesplitst: de tweede helft is voor #R-2 Second')));
    assert.ok(summaries.some((summary) => /^Ronde 1 van #R-2 Second .* verwijderd$/.test(summary)));
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a laptop that was off catches up by itself, also across many batches', { timeout: 60_000 }, async () => {
  const root = testRoot('follower-off');
  const servers: RunningServer[] = [];
  try {
    await startGroup(root, servers);
    const leader = (await leaderOf(servers))!;
    const offline = servers.find((server) => server !== leader)!;
    await killServer(offline);
    // Two of three laptops are a majority, so everything keeps working. More than one batch of 500
    // entries piles up; the writes go in chunks, as 520 at once can outlast the commit timeout on a slow disk.
    for (let start = 0; start < 520; start += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, 520 - start) }, (_, offset) => start + offset).map((index) =>
          client(leader).runners.create.mutate({ name: `Offline write ${index}`, runnerNumber: `OFF-${index}` })
        )
      );
    }
    // Its announcements stopped long ago; the group still knows its name.
    const offlineStatus = (await fetchStatus(leader)).members.find((member) => member.url === offline.baseUrl);
    assert.equal(offlineStatus?.reachable, false);
    assert.equal(offlineStatus?.name, offline.name);
    const restarted = await startServer({ port: offline.port, dataPath: offline.dataPath, name: offline.name });
    servers[servers.indexOf(offline)] = restarted;
    await waitForSameState(leader, restarted, 20_000);
    assert.equal((await fetchStatus(restarted)).role, 'follower');
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'a laptop that was off catches up when it missed more logos than fit in one message',
  { timeout: 60_000 },
  async () => {
    const root = testRoot('follower-off-logos');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const leader = (await leaderOf(servers))!;
      const offline = servers.find((server) => server !== leader)!;
      await killServer(offline);
      // 25 logos of about 1 MB each: more than one 20 MB peer message.
      const images: string[] = [];
      for (let index = 0; index < 25; index += 1) {
        const dataBase64 = crypto.randomBytes(740_000).toString('base64');
        images.push((await client(leader).labels.uploadImage.mutate({ mime: 'image/png', dataBase64 })).imageUrl);
      }
      const restarted = await startServer({ port: offline.port, dataPath: offline.dataPath });
      servers[servers.indexOf(offline)] = restarted;
      const { logHead } = await fetchStatus(leader);
      // At least that far: the leader may write more meanwhile, such as this laptop's new name.
      await waitFor(async () => (await fetchStatus(restarted)).logHead >= logHead, 30_000, 200);
      const { hostId } = (await fetchStatus(restarted)).members.find((member) => member.self)!;
      await waitFor(async () => {
        const member = (await fetchStatus(leader)).members.find((entry) => entry.hostId === hostId);
        return Boolean(member?.reachable && member.caughtUp);
      });
      assert.equal((await fetch(`${restarted.baseUrl}${images.at(-1)}`)).status, 200);
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'a laptop cut off from the others saves nothing, and takes the group data when the cable is back',
  { timeout: 40_000 },
  async () => {
    const root = testRoot('cut-off');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const cutOff = (await leaderOf(servers))!;
      const others = servers.filter((server) => server !== cutOff);
      await client(cutOff).runners.create.mutate({ name: 'Shared', runnerNumber: 'S-1' });

      await isolate(cutOff, true);
      await assert.rejects(
        client(cutOff).runners.create.mutate({ name: 'Never confirmed', runnerNumber: 'S-2' }),
        /Niet bevestigd|Niet opgeslagen/
      );
      await waitFor(async () => (await leaderOf(others)) !== null, 10_000);
      await client(others[0]).runners.create.mutate({ name: 'Written by the majority', runnerNumber: 'S-3' });
      assert.equal((await fetchStatus(cutOff)).writable, false);

      await isolate(cutOff, false);
      await waitForSameState(others[0], cutOff, 10_000);
      const names = (await fetchState(cutOff)).runners.map((runner) => runner.name).sort();
      assert.deepEqual(names, ['Shared', 'Written by the majority']);
      const backups = fs.readdirSync(path.join(cutOff.dataPath, 'backups'));
      assert.ok(
        backups.some((file) => file.includes('pre-resync')),
        backups.join(', ')
      );
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'Koppelen on the laptop with the runners brings the empty laptops over instead of emptying it',
  { timeout: 60_000 },
  async () => {
    const root = testRoot('direction');
    const servers: RunningServer[] = [];
    try {
      const full = await startServer({ port: await freePort(), dataPath: path.join(root, 'full') });
      servers.push(full);
      await client(full).runners.create.mutate({ name: 'Imported', runnerNumber: 'I-1' });
      const empties: RunningServer[] = [];
      for (const name of ['a', 'b']) {
        const empty = await startServer({ port: await freePort(), dataPath: path.join(root, name) });
        servers.push(empty);
        empties.push(empty);
      }
      const [a, b] = empties;

      // Two empty laptops pressed at the same moment end up as one group of two.
      await Promise.all([join(a, b), join(b, a)]);
      await waitFor(async () => (await fetchStatus(a)).state === 'healthy', 10_000);
      assert.equal((await fetchStatus(a)).clusterId, (await fetchStatus(b)).clusterId);
      assert.equal((await fetchStatus(b)).members.length, 2);

      // Another laptop cannot make the laptop with the runners take an empty group's data.
      const pair = await fetchStatus(a);
      const refused = await fetch(`${full.baseUrl}/api/cluster/invite`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-apolloon-app-version': '1.0.0',
          'x-apolloon-schema-version': String(pair.schemaVersion),
        },
        body: JSON.stringify({ url: a.baseUrl, clusterId: pair.clusterId }),
      });
      assert.equal(refused.status, 409);
      await waitFor(async () =>
        (await fetchStatus(full)).nearby.some((group) => group.laptops === 2 && group.link === 'invite')
      );
      await waitFor(async () => (await fetchStatus(a)).nearby.some((group) => group.link === 'join'));

      // Koppelen on the laptop with the runners: both empty laptops take its data.
      await join(full, a);
      await waitForSameState(full, a, 15_000);
      await waitForSameState(full, b, 15_000);
      assert.deepEqual(
        (await fetchState(b)).runners.map((runner) => runner.name),
        ['Imported']
      );
      await waitFor(async () => (await fetchStatus(full)).state === 'healthy', 15_000);
      assert.equal((await fetchStatus(full)).members.length, 3);
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'with two laptops gone for good, the last one goes on alone and the others rejoin with its data',
  { timeout: 60_000 },
  async () => {
    const root = testRoot('alone');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const [last, ...gone] = servers;
      await client(last).runners.create.mutate({ name: 'Before', runnerNumber: 'L-1' });
      await waitForSameState(last, gone[0]);
      await waitForSameState(last, gone[1]);
      await Promise.all(gone.map(killServer));

      await waitFor(async () => (await fetchStatus(last)).state === 'no-majority', 15_000);
      await assert.rejects(
        client(last).runners.create.mutate({ name: 'Nobody to confirm', runnerNumber: 'L-2' }),
        /Niet opgeslagen|Niet bevestigd/
      );
      await client(last).cluster.continueAlone.mutate();
      await client(last).runners.create.mutate({ name: 'Alone', runnerNumber: 'L-3' });

      for (const [index, server] of gone.entries()) {
        const restarted = await startServer({ port: server.port, dataPath: server.dataPath });
        servers[index + 1] = restarted;
      }
      await waitForSameState(last, servers[1], 15_000);
      await waitForSameState(last, servers[2], 15_000);
      assert.deepEqual((await fetchState(servers[2])).runners.map((runner) => runner.name).sort(), ['Alone', 'Before']);
      await waitFor(async () => (await fetchStatus(last)).state === 'healthy', 15_000);
      assert.equal((await fetchStatus(last)).members.length, 3);
      const activity = await client(servers[2]).activity.list.query({ limit: 100, before: null });
      const alone = activity.find((entry) => entry.action === 'cluster.continueAlone');
      assert.equal(alone?.summary, 'Alleen verder gewerkt op LAPTOP-A; LAPTOP-B en LAPTOP-C zijn uit de groep gehaald');
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'a laptop gone for good is taken out, a spare takes its place, and the group survives one more failure',
  { timeout: 90_000 },
  async () => {
    const root = testRoot('replace');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const leader = (await leaderOf(servers))!;
      const [follower, dead] = servers.filter((server) => server !== leader);
      const hostIdOf = async (server: RunningServer) => (await fetchStatus(server)).hostId;
      const deadId = await hostIdOf(dead);
      const followerId = await hostIdOf(follower);
      const leaderId = await hostIdOf(leader);
      await client(leader).runners.create.mutate({ name: 'Before', runnerNumber: 'P-1' });
      await waitForSameState(leader, dead);
      await killServer(dead);

      // A laptop that answers cannot be taken out, and the one that broke only after a while.
      await assert.rejects(
        client(follower).cluster.removeMember.mutate({ hostId: followerId }),
        /niet lang genoeg onbereikbaar/
      );
      await waitFor(async () =>
        Boolean((await fetchStatus(follower)).members.find((member) => member.hostId === deadId)?.removable)
      );
      // Taken out on a laptop that does not lead: the leader makes the change.
      assert.deepEqual(await client(follower).cluster.removeMember.mutate({ hostId: deadId }), { name: 'LAPTOP-C' });
      for (const server of [leader, follower]) {
        await waitFor(async () => {
          const status = await fetchStatus(server);
          return status.members.length === 2 && status.majority === 2 && status.state === 'healthy';
        });
      }
      const activity = await client(leader).activity.list.query({ limit: 50, before: null });
      const removal = activity.find((entry) => entry.action === 'cluster.removeMember');
      assert.equal(removal?.summary, 'LAPTOP-C uit de groep gehaald');

      // The spare links in its place: three laptops again, so one more may fail.
      const spare = await startServer({ port: await freePort(), dataPath: path.join(root, 'd'), name: 'LAPTOP-D' });
      servers.push(spare);
      await join(spare, leader);
      await waitFor(async () => {
        const status = await fetchStatus(leader);
        return status.state === 'healthy' && status.members.length === 3;
      }, 15_000);
      assert.equal((await fetchStatus(leader)).majority, 2);
      await waitForSameState(leader, spare);

      await killServer(leader);
      const after = await client(follower).runners.create.mutate({ name: 'After two failures', runnerNumber: 'P-2' });
      assert.equal(after.runnerNumber, 'P-2');
      await waitForSameState(follower, spare);

      // The broken laptop comes back: it is not taken in by itself and saves nothing, but says why.
      const returned = await startServer({ port: dead.port, dataPath: dead.dataPath, name: 'LAPTOP-C' });
      servers[servers.indexOf(dead)] = returned;
      await waitFor(async () => (await fetchStatus(returned)).removedFrom !== null, 15_000);
      assert.equal((await fetchStatus(returned)).writable, false);
      const group = (await fetchStatus(follower)).members.map((member) => member.hostId);
      assert.deepEqual(group.sort(), [leaderId, followerId, await hostIdOf(spare)].sort());

      // Koppelen on it takes it back in, with the group's data.
      await join(returned, follower);
      await waitForSameState(follower, returned, 15_000);
      assert.deepEqual((await fetchState(returned)).runners.map((runner) => runner.name).sort(), [
        'After two failures',
        'Before',
      ]);
      assert.ok((await fetchStatus(follower)).members.some((member) => member.hostId === deadId));
      assert.equal((await fetchStatus(returned)).removedFrom, null);
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'a spare linked in after a removal keeps the removed laptop out, also when the spare leads',
  { timeout: 120_000 },
  async () => {
    const root = testRoot('spare-leads');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const first = (await leaderOf(servers))!;
      const [other, broken] = servers.filter((server) => server !== first);
      const brokenId = (await fetchStatus(broken)).hostId;
      const firstId = (await fetchStatus(first)).hostId;
      await killServer(broken);
      await waitFor(async () =>
        Boolean((await fetchStatus(other)).members.find((member) => member.hostId === brokenId)?.removable)
      );
      await client(other).cluster.removeMember.mutate({ hostId: brokenId });

      // The spare takes a full copy of the group, made after the removal.
      const spare = await startServer({ port: await freePort(), dataPath: path.join(root, 'd'), name: 'LAPTOP-D' });
      servers.push(spare);
      await join(spare, first);
      await waitFor(async () => {
        const status = await fetchStatus(first);
        return status.state === 'healthy' && status.members.length === 3;
      }, 15_000);
      await waitForSameState(first, spare);

      // The leader breaks too, and the spare takes the lead: the other laptop restarts until it does.
      await killServer(first);
      let follower = other;
      for (let attempt = 0; ; attempt += 1) {
        await waitFor(async () => (await leaderOf([follower, spare])) !== null, 15_000);
        if ((await leaderOf([follower, spare])) === spare) break;
        assert.ok(attempt < 5, 'the spare never took the lead');
        await killServer(follower);
        follower = await startServer({ port: follower.port, dataPath: follower.dataPath, name: follower.name });
        servers.push(follower);
      }

      // The spare, leading, takes the broken leader out; the first removal must survive that write.
      await waitFor(async () =>
        Boolean((await fetchStatus(spare)).members.find((member) => member.hostId === firstId)?.removable)
      );
      await client(spare).cluster.removeMember.mutate({ hostId: firstId });
      await waitFor(async () => (await fetchStatus(follower)).members.length === 2);

      // The laptop taken out first comes back: it is still refused, and says why.
      const returned = await startServer({ port: broken.port, dataPath: broken.dataPath, name: 'LAPTOP-C' });
      servers.push(returned);
      await waitFor(async () => (await fetchStatus(returned)).removedFrom !== null, 15_000);
      assert.equal((await fetchStatus(returned)).writable, false);
      for (const server of [spare, follower]) {
        assert.equal(
          (await fetchStatus(server)).members.some((member) => member.hostId === brokenId),
          false
        );
      }
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('Koppelen right after the leader died waits for the new leader and links', { timeout: 60_000 }, async () => {
  const root = testRoot('join-takeover');
  const servers: RunningServer[] = [];
  try {
    await startGroup(root, servers);
    const spare = await startServer({ port: await freePort(), dataPath: path.join(root, 'd'), name: 'LAPTOP-D' });
    servers.push(spare);
    const leader = (await leaderOf(servers))!;
    const follower = servers.find((server) => server !== leader && server !== spare)!;
    await client(leader).runners.create.mutate({ name: 'Before', runnerNumber: 'T-1' });
    await waitForSameState(leader, follower);

    // Pressed once, without trying again: the follower still names the dead laptop as its leader.
    await killServer(leader);
    await client(spare).cluster.join.mutate({ url: follower.baseUrl });
    await waitForSameState(follower, spare, 15_000);
    assert.deepEqual(
      (await fetchState(spare)).runners.map((runner) => runner.name),
      ['Before']
    );
    const spareId = (await fetchStatus(spare)).hostId;
    assert.ok((await fetchStatus(follower)).members.some((member) => member.hostId === spareId));
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'Activiteit lists each laptop that links, drops out and comes back, once, on every laptop',
  { timeout: 60_000 },
  async () => {
    const root = testRoot('activity-laptops');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const summaries = async (server: RunningServer) =>
        (await client(server).activity.list.query({ limit: 100, before: null })).map((entry) => entry.summary);
      // Which of two empty laptops moves is up to the group ids; either way two of the three came over.
      const linked = async () =>
        (await summaries(servers[2])).filter((summary) => /^LAPTOP-[ABC] gekoppeld met Koppelen$/.test(summary));
      await waitFor(async () => (await linked()).length === 2);

      // The laptop that leads dies: the one that takes over lists it, from a list it never kept itself.
      const gone = await leaderOf(servers);
      assert.ok(gone);
      const index = servers.indexOf(gone);
      await killServer(gone);
      const others = servers.filter((server) => server !== gone);
      await waitFor(async () => (await summaries(others[0])).includes(`${gone.name} is niet bereikbaar`), 20_000, 200);
      const leader = await leaderOf(others);
      assert.ok(leader);

      servers[index] = await startServer({ port: gone.port, dataPath: gone.dataPath, name: gone.name });
      // Read on the laptop that came back: the entries reached it with the rest of the data.
      await waitFor(
        async () => (await summaries(servers[index])).includes(`${gone.name} is weer bereikbaar`),
        20_000,
        200
      );
      const listed = await summaries(servers[index]);
      assert.equal(listed.filter((summary) => summary === `${gone.name} is niet bereikbaar`).length, 1);
      assert.equal(listed.filter((summary) => summary === `${gone.name} is weer bereikbaar`).length, 1);
      // Written by whichever laptop led when it came back, which may be the returning laptop itself.
      const entry = (await client(leader).activity.list.query({ limit: 100, before: null })).find(
        (item) => item.summary === `${gone.name} is weer bereikbaar`
      );
      assert.match(entry?.origin ?? '', /^Vanzelf · laptop LAPTOP-[ABC] /);
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'a laptop whose data was wiped and linked again replaces its old self, so two of three still save',
  { timeout: 60_000 },
  async () => {
    const root = testRoot('relink-wiped');
    const servers: RunningServer[] = [];
    try {
      await startGroup(root, servers);
      const [first, second, wiped] = servers;
      const oldHostId = (await fetchStatus(wiped)).hostId;

      // A reinstall: the same laptop at the same address, with a new host id.
      await stopServer(wiped);
      fs.rmSync(wiped.dataPath, { recursive: true, force: true });
      const relinked = await startServer({ port: wiped.port, dataPath: wiped.dataPath });
      servers[2] = relinked;
      await join(relinked, first);
      await waitForSameState(first, relinked);

      const status = await fetchStatus(first);
      assert.equal(status.members.length, 3, JSON.stringify(status.members));
      assert.equal(status.majority, 2);
      assert.ok(!status.members.some((member) => member.hostId === oldHostId));

      await killServer(relinked);
      await waitFor(async () => (await leaderOf([first, second])) !== null, 10_000);
      const leader = (await leaderOf([first, second]))!;
      await client(leader).runners.create.mutate({ name: 'Saved by two of three', runnerNumber: 'W-1' });
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('the laptops find each other again when every address changes', { timeout: 60_000 }, async () => {
  const root = testRoot('new-addresses');
  const servers: RunningServer[] = [];
  try {
    await startGroup(root, servers);
    await client(servers[0]).runners.create.mutate({ name: 'Before the new router', runnerNumber: 'N-1' });
    await waitForSameState(servers[0], servers[1]);
    await waitForSameState(servers[0], servers[2]);

    // Like a router swap: every laptop comes back at an address the others never saw.
    await Promise.all(servers.map(stopServer));
    for (const [index, server] of servers.entries()) {
      servers[index] = await startServer({ port: await freePort(), dataPath: server.dataPath });
    }
    await waitFor(async () => (await fetchStatus(servers[0])).state === 'healthy', 20_000);
    await client(servers[2]).runners.create.mutate({ name: 'After the new router', runnerNumber: 'N-2' });
    await waitForSameState(servers[2], servers[0]);
    await waitForSameState(servers[2], servers[1]);
    const urls = (await fetchStatus(servers[1])).members.map((member) => member.url).sort();
    assert.deepEqual(urls, servers.map((server) => server.baseUrl).sort());
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a write repeated after a takeover is applied once', { timeout: 30_000 }, async () => {
  const root = testRoot('repeat');
  const servers: RunningServer[] = [];
  try {
    await startGroup(root, servers);
    const leader = (await leaderOf(servers))!;
    const send = async () => {
      const response = await fetch(`${leader.baseUrl}/trpc/runners.create`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-apolloon-forwarded': '1',
          'x-apolloon-request-id': 'repeated-request',
        },
        body: JSON.stringify({ name: 'Once', runnerNumber: 'ONCE-1' }),
      });
      assert.equal(response.ok, true, await response.clone().text());
      return ((await response.json()) as { result: { data: { id: string } } }).result.data.id;
    };
    const [firstId, repeatId] = [await send(), await send()];
    assert.equal(repeatId, firstId);
    assert.equal((await fetchState(leader)).runners.filter((runner) => runner.name === 'Once').length, 1);
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('laptops with different app versions refuse to couple', { timeout: 20_000 }, async () => {
  const root = testRoot('versions');
  const servers: RunningServer[] = [];
  try {
    const first = await startServer({ port: await freePort(), dataPath: path.join(root, 'a'), appVersion: '1.0.0' });
    const other = await startServer({ port: await freePort(), dataPath: path.join(root, 'b'), appVersion: '2.0.0' });
    servers.push(first, other);
    await assert.rejects(client(other).cluster.join.mutate({ url: first.baseUrl }), /Upgrade vereist/);
    assert.equal(
      await peerSocketStatus(first, { 'x-apolloon-app-version': '2.0.0', 'x-apolloon-schema-version': '13' }),
      426
    );
  } catch (error) {
    throw withServerOutput(error, ...servers);
  } finally {
    await Promise.all(servers.map(stopServer));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'empty laptops link by themselves, once, and then take the data of a laptop that holds runners',
  { timeout: 60_000 },
  async () => {
    const root = testRoot('auto-link');
    const servers: RunningServer[] = [];
    try {
      // Two empty laptops started at the same moment: one of them joins the other, not both.
      const ports = [await freePort(), await freePort()];
      servers.push(
        ...(await Promise.all(
          ['A', 'B'].map((name, index) =>
            startServer({
              port: ports[index],
              dataPath: path.join(root, name),
              name: `LAPTOP-${name}`,
              autoLink: true,
            })
          )
        ))
      );
      const [a, b] = servers;
      const oneGroup = async (group: RunningServer[], size: number) => {
        const statuses = await Promise.all(group.map(fetchStatus));
        return statuses.every(
          (status) => status.clusterId === statuses[0].clusterId && status.members.length === size && status.writable
        );
      };
      await waitFor(() => oneGroup([a, b], 2), 20_000, 200);
      assert.equal((await fetchStatus(a)).autoLink.linked.length, 1);

      // A laptop with runners shows up later. It never links by itself; the empty pair takes its data.
      const seeded = await startServer({
        port: await freePort(),
        dataPath: path.join(root, 'seeded'),
        name: 'LAPTOP-TIJD',
      });
      servers.push(seeded);
      await client(seeded).runners.create.mutate({ name: 'Ingeschreven', runnerNumber: 'T-1' });
      await waitFor(() => oneGroup([seeded, a, b], 3), 30_000, 200);
      assert.equal((await fetchStatus(a)).clusterId, (await fetchStatus(seeded)).clusterId);
      await waitForSameState(seeded, a);
      await waitForSameState(seeded, b);
      // Every laptop of the group can say which laptops came over by themselves, and to which laptop.
      const linked = (await fetchStatus(seeded)).autoLink.linked;
      assert.deepEqual(linked.map((link) => `${link.name} > ${link.with}`).sort(), [
        'LAPTOP-A > LAPTOP-TIJD',
        'LAPTOP-B > LAPTOP-TIJD',
      ]);
      assert.equal((await fetchStatus(b)).autoLink.linked.find((link) => link.self)?.with, 'LAPTOP-TIJD');
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'a fresh laptop takes the data of a laptop someone prepared, not the other way round',
  { timeout: 60_000 },
  async () => {
    const root = testRoot('auto-link-prepared');
    const servers: RunningServer[] = [];
    try {
      // A teacher prepares the event on the first laptop before any runner is imported.
      const prepared = await startServer({
        port: await freePort(),
        dataPath: path.join(root, 'prepared'),
        name: 'LAPTOP-KLAAR',
        autoLink: true,
      });
      servers.push(prepared);
      await client(prepared).labels.create.mutate({ name: 'Trojan Horse', kind: 'temporary_team' });
      assert.equal((await fetchStatus(prepared)).changed, true);

      const fresh = await startServer({
        port: await freePort(),
        dataPath: path.join(root, 'fresh'),
        name: 'LAPTOP-NIEUW',
        autoLink: true,
      });
      servers.push(fresh);
      await waitFor(
        async () => {
          const [a, b] = await Promise.all([fetchStatus(prepared), fetchStatus(fresh)]);
          return a.clusterId === b.clusterId && a.members.length === 2 && a.writable;
        },
        20_000,
        200
      );
      await waitForSameState(prepared, fresh);
      for (const server of [prepared, fresh]) {
        assert.ok((await fetchState(server)).labels.some((label) => label.name === 'Trojan Horse'));
      }
      assert.equal((await fetchStatus(prepared)).autoLink.linked[0]?.with, 'LAPTOP-KLAAR');
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'laptops with runners never link by themselves, and an empty laptop that hears two of them waits for a press',
  { timeout: 60_000 },
  async () => {
    const root = testRoot('auto-link-runners');
    const servers: RunningServer[] = [];
    try {
      // Each gets its runners before linking by itself is on, so it was never an empty laptop with it on.
      for (const name of ['P', 'Q']) {
        const options = { port: await freePort(), dataPath: path.join(root, name), name: `LAPTOP-${name}` };
        const setup = await startServer(options);
        servers.push(setup);
        await client(setup).runners.create.mutate({ name: `Loper ${name}`, runnerNumber: `${name}-1` });
        await stopServer(setup);
        servers.splice(servers.indexOf(setup), 1, await startServer({ ...options, autoLink: true }));
      }
      const empty = await startServer({
        port: await freePort(),
        dataPath: path.join(root, 'empty'),
        name: 'LAPTOP-LEEG',
        autoLink: true,
      });
      servers.push(empty);
      await waitFor(
        async () =>
          /LAPTOP-P en LAPTOP-Q hebben elk lopers|LAPTOP-Q en LAPTOP-P hebben elk lopers/.test(
            (await fetchStatus(empty)).autoLink.waiting ?? ''
          ),
        15_000,
        200
      );
      // Two rounds of the five-second check later, nobody moved.
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      const statuses = await Promise.all(servers.map(fetchStatus));
      assert.equal(new Set(statuses.map((status) => status.clusterId)).size, 3);
      assert.deepEqual(
        statuses.map((status) => status.members.length),
        [1, 1, 1]
      );
      assert.deepEqual(
        statuses.map((status) => status.runners),
        [1, 1, 0]
      );
      assert.ok(statuses[2].autoLink.waiting);
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      await Promise.all(servers.map(stopServer));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'an empty laptop whose link by itself keeps failing says why: an address that does not answer, then the error',
  { timeout: 90_000 },
  async () => {
    const root = testRoot('auto-link-fails');
    const servers: RunningServer[] = [];
    // A laptop with runners as the empty one sees it: its announcements, and its address.
    const otherPort = await freePort();
    let otherAnswers = false;
    const other = http.createServer((req, res) => {
      if (!otherAnswers) return req.socket.destroy();
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/cluster/members') {
        res.statusCode = 503;
        return res.end(JSON.stringify({ code: 'no_majority', error: 'Te weinig laptops bereikbaar.' }));
      }
      res.end(JSON.stringify(otherStatus));
    });
    await new Promise<void>((resolve) => other.listen(otherPort, '127.0.0.1', resolve));
    const otherUrl = `http://127.0.0.1:${otherPort}`;
    let otherStatus: Partial<ClusterStatus> = {};
    const announcing = setInterval(
      () =>
        void announce({
          hostId: 'other-laptop',
          name: 'LAPTOP-TIJD',
          clusterId: 'other-group',
          url: otherUrl,
          appVersion: '1.0.0',
          schemaVersion: otherStatus.schemaVersion ?? 0,
          leader: true,
          groupSize: 1,
          runners: 40,
        }),
      200
    );
    try {
      const empty = await startServer({
        port: await freePort(),
        dataPath: path.join(root, 'empty'),
        name: 'LAPTOP-LEEG',
        autoLink: true,
      });
      servers.push(empty);
      const own = await fetchStatus(empty);
      const leader = { hostId: 'other-laptop', url: otherUrl, name: 'LAPTOP-TIJD' };
      otherStatus = {
        enabled: true,
        hostId: 'other-laptop',
        hostName: 'LAPTOP-TIJD',
        clusterId: 'other-group',
        appVersion: own.appVersion,
        schemaVersion: own.schemaVersion,
        leader,
        members: [],
        runners: 40,
        busy: null,
      };
      const waiting = async (pattern: RegExp) => pattern.test((await fetchStatus(empty)).autoLink.waiting ?? '');

      // Heard but not answering, as behind a firewall that lets the announcements through.
      await waitFor(
        () => waiting(/LAPTOP-TIJD is te zien op het netwerk, maar 127\.0\.0\.1:\d+ antwoordt niet/),
        30_000,
        200
      );

      // Answering, but the join itself fails: the screen gets that laptop's own words.
      otherAnswers = true;
      await waitFor(
        () => waiting(/Vanzelf koppelen met LAPTOP-TIJD lukt niet: Te weinig laptops bereikbaar\./),
        30_000,
        200
      );
      const status = await fetchStatus(empty);
      assert.equal(status.clusterId, own.clusterId);
      assert.equal(status.members.length, 1);
    } catch (error) {
      throw withServerOutput(error, ...servers);
    } finally {
      clearInterval(announcing);
      await Promise.all(servers.map(stopServer));
      await new Promise((resolve) => other.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

/** The HTTP status another laptop gets when it opens the socket for appends and votes; 101 when accepted. */
function peerSocketStatus(server: RunningServer, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}${PEER_SOCKET_PATH}`, { headers });
    socket.on('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('open', () => {
      resolve(101);
      socket.terminate();
    });
    socket.on('error', reject);
  });
}

function client(server: RunningServer) {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${server.baseUrl}/trpc` })] });
}

/** Three laptops in one group, like at the event; pushed onto `servers` as they start so they are always stopped. */
async function startGroup(root: string, servers: RunningServer[]): Promise<void> {
  for (const name of ['a', 'b', 'c']) {
    servers.push(
      await startServer({
        port: await freePort(),
        dataPath: path.join(root, name),
        name: `LAPTOP-${name.toUpperCase()}`,
      })
    );
  }
  for (const server of servers.slice(1)) await join(server, servers[0]);
  await waitFor(async () => (await fetchStatus(servers[0])).state === 'healthy', 10_000);
}

/**
 * Links `server` to the group of `target`. Right after a laptop joins, the
 * group may briefly re-confirm its leader (a slow runner can miss a
 * heartbeat), and joining then answers "try again"; like an operator, try again.
 */
async function join(server: RunningServer, target: RunningServer) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await client(server).cluster.join.mutate({ url: target.baseUrl });
    } catch (error) {
      if (!/Probeer het zo opnieuw/.test(String(error)) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function leaderOf(servers: RunningServer[]): Promise<RunningServer | null> {
  const statuses = await Promise.all(servers.map((server) => fetchStatus(server).catch(() => null)));
  const index = statuses.findIndex((status) => status?.role === 'leader' && status.writable);
  return index >= 0 ? servers[index] : null;
}

/** Simulates a pulled network cable. */
async function isolate(server: RunningServer, isolated: boolean): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/cluster/test/isolate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isolated }),
  });
  assert.equal(response.ok, true);
}

async function startServer(options: {
  port: number;
  dataPath: string;
  clusterEnabled?: boolean;
  appVersion?: string;
  name?: string;
  /** Linking by itself; off in the other tests, which link with Koppelen. */
  autoLink?: boolean;
}): Promise<RunningServer> {
  fs.mkdirSync(options.dataPath, { recursive: true });
  const chunks: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(options.port),
      PUBLIC_APP_PORT: String(options.port),
      DATA_PATH: options.dataPath,
      CLUSTER_ENABLED: options.clusterEnabled === false ? 'false' : 'true',
      CLUSTER_SELF_URL: `http://127.0.0.1:${options.port}`,
      CLUSTER_HEARTBEAT_MS: '50',
      CLUSTER_ELECTION_TIMEOUT_MS: '400',
      CLUSTER_COMMIT_TIMEOUT_MS: '3000',
      CLUSTER_WRITE_DEADLINE_MS: '6000',
      CLUSTER_REMOVABLE_AFTER_MS: '1500',
      CLUSTER_REQUEST_TIMEOUT_MS: '300',
      CLUSTER_TEST_FAULTS: 'true',
      CLUSTER_DISCOVERY_ADDRESS: '127.255.255.255',
      CLUSTER_DISCOVERY_PORT: String(discoveryPort),
      CLUSTER_DISCOVERY_INTERVAL_MS: '200',
      CLUSTER_LAPTOP_NAME: options.name ?? '',
      CLUSTER_AUTO_LINK: String(options.autoLink === true),
      BACKUP_ENABLED: 'false',
      APOLLOON_RELEASE_ID: 'e2e-test-release',
      APOLLOON_APP_VERSION: options.appVersion || '1.0.0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => chunks.push(chunk.toString()));
  child.stderr?.on('data', (chunk) => chunks.push(chunk.toString()));
  const server: RunningServer = {
    process: child,
    port: options.port,
    baseUrl: `http://127.0.0.1:${options.port}`,
    dataPath: options.dataPath,
    name: options.name,
    output: () => chunks.join(''),
    stopping: false,
  };
  child.once('exit', (code, signal) => {
    chunks.push(`\n[exited: ${code ?? signal}]\n`);
    if (!server.stopping) {
      process.stderr.write(`Server ${server.baseUrl} stopped unexpectedly (${code ?? signal}):\n${server.output()}\n`);
    }
  });
  await waitFor(async () => {
    if (hasExited(server)) throw new Error(`server exited\n${server.output()}`);
    return (await fetch(`${server.baseUrl}/api/host-info`).catch(() => null))?.ok === true;
  });
  return server;
}

/** One announcement as a laptop of an older version sends it, without a computer name. */
async function announceWithoutName(url: string): Promise<void> {
  await announce({
    hostId: 'old-laptop',
    clusterId: 'old-group',
    url,
    appVersion: '0.9.0',
    schemaVersion: 1,
    leader: true,
    groupSize: 1,
    runners: 0,
  });
}

/** One announcement on the test network, as a laptop sends it (`server/discovery.ts`). */
async function announce(fields: Record<string, unknown>): Promise<void> {
  const beacon = { app: 'apolloon', ...fields };
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    socket.setBroadcast(true);
    await new Promise((resolve) => socket.send(JSON.stringify(beacon), discoveryPort, '127.255.255.255', resolve));
  } finally {
    socket.close();
  }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || hasExited(server)) return;
  server.stopping = true;
  const exited = waitForExit(server);
  server.process.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  if (!hasExited(server)) server.process.kill('SIGKILL');
  await exited;
}

/** A laptop that suddenly loses power. */
async function killServer(server: RunningServer): Promise<void> {
  if (hasExited(server)) return;
  server.stopping = true;
  const exited = waitForExit(server);
  server.process.kill('SIGKILL');
  await exited;
}

/** A process killed by a signal keeps `exitCode` null, so both are checked. */
function hasExited(server: RunningServer): boolean {
  return server.process.exitCode !== null || server.process.signalCode !== null;
}

function waitForExit(server: RunningServer): Promise<void> {
  if (hasExited(server)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${server.baseUrl} did not stop\n${server.output()}`)), 10_000);
    server.process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function fetchState(server: RunningServer): Promise<AppSnapshot> {
  const [stateResponse, historyResponse] = await Promise.all([
    fetch(`${server.baseUrl}/api/state`),
    fetch(`${server.baseUrl}/api/history`),
  ]);
  assert.equal(stateResponse.ok, true);
  assert.equal(historyResponse.ok, true);
  const [state, history] = await Promise.all([
    stateResponse.json() as Promise<LiveAppSnapshot>,
    historyResponse.json() as Promise<RaceHistory>,
  ]);
  return { ...state, laps: history.laps, events: history.events };
}

async function fetchStatus(server: RunningServer): Promise<ClusterStatus> {
  const response = await fetch(`${server.baseUrl}/api/cluster/status`);
  assert.equal(response.ok, true);
  return response.json() as Promise<ClusterStatus>;
}

function comparableState(state: AppSnapshot): unknown {
  const { revision: _revision, host: _host, ...data } = state;
  return data;
}

async function waitForSameState(source: RunningServer, copy: RunningServer, timeoutMs = 8_000): Promise<void> {
  await waitFor(async () => {
    const [expected, actual] = await Promise.all([fetchState(source), fetchState(copy)]);
    return JSON.stringify(comparableState(expected)) === JSON.stringify(comparableState(actual));
  }, timeoutMs);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Condition timed out');
}

function testRoot(name: string): string {
  // In the system's temporary folder, so a run that is cut off leaves nothing in the repository.
  return fs.mkdtempSync(path.join(os.tmpdir(), `apolloon-test-cluster-${name}-`));
}

function withServerOutput(error: unknown, ...servers: Array<RunningServer | null>): Error {
  const output = servers
    .filter((server): server is RunningServer => Boolean(server))
    .map((server) => `${server.baseUrl}\n${server.output()}`)
    .join('\n');
  return new Error(`${error instanceof Error ? error.stack || error.message : String(error)}\n${output}`);
}
