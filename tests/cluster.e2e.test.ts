import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
    const first = await startServer({ port: await freePort(), dataPath: path.join(root, 'first') });
    servers.push(first);
    await client(first).runners.create.mutate({ name: 'Before the group', runnerNumber: 'A-1' });
    const second = await startServer({ port: await freePort(), dataPath: path.join(root, 'second') });
    servers.push(second);
    await client(second).runners.create.mutate({ name: 'Replaced by the join', runnerNumber: 'B-1' });
    // A laptop on its own lists the laptops it could join, without anyone typing an address.
    await waitFor(async () =>
      (await fetchStatus(second)).nearby.some((group) => group.url === first.baseUrl && group.runners === 1)
    );
    const joined = await join(second, first);
    assert.match(joined.backupFile ?? '', /pre-join/);
    const third = await startServer({ port: await freePort(), dataPath: path.join(root, 'third') });
    servers.push(third);
    await waitFor(async () => (await fetchStatus(third)).nearby.some((group) => group.laptops === 2));
    assert.equal((await fetchStatus(third)).nearby.length, 1, 'the two linked laptops are listed as one group');
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
      'Before the group',
      'Written on laptop 0',
      'Written on laptop 1',
      'Written on laptop 2',
    ]);
    const status = await fetchStatus(third);
    assert.equal(status.members.length, 3);
    assert.equal(status.majority, 2);
    assert.deepEqual(status.memberUrls.sort(), [first.baseUrl, second.baseUrl].sort());
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
    const restarted = await startServer({ port: offline.port, dataPath: offline.dataPath });
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
      await waitFor(async () => (await fetchStatus(restarted)).logHead === logHead, 30_000, 200);
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
    servers.push(await startServer({ port: await freePort(), dataPath: path.join(root, name) }));
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
      CLUSTER_REQUEST_TIMEOUT_MS: '300',
      CLUSTER_TEST_FAULTS: 'true',
      CLUSTER_DISCOVERY_ADDRESS: '127.255.255.255',
      CLUSTER_DISCOVERY_PORT: String(discoveryPort),
      CLUSTER_DISCOVERY_INTERVAL_MS: '200',
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
