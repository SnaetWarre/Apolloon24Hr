import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { APP_VERSION } from '../server/env.ts';
import { DATABASE_SCHEMA_VERSION } from '../server/db.ts';
import { forwardWrite } from '../server/cluster.ts';
import { PeerVersionError, peerSocketAnswerSchema, readPeerStatus, trpcAnswerSchema } from '../server/peer-messages.ts';
import { acceptPeerSocket, closePeerSockets, peerRequest } from '../server/peer-socket.ts';

const status = {
  enabled: true,
  hostId: 'host-b',
  hostName: 'LAPTOP-B',
  clusterId: 'cluster-b',
  appVersion: APP_VERSION,
  schemaVersion: DATABASE_SCHEMA_VERSION,
  role: 'leader',
  term: 3,
  leader: { hostId: 'host-b', url: 'http://10.0.0.2:3000' },
  members: [{ hostId: 'host-b', url: 'http://10.0.0.2:3000', name: 'LAPTOP-B' }],
  busy: null,
  runners: 12,
  changed: true,
  raceStarted: false,
  raceRunning: false,
  timing: null,
  split: { id: 'split-1', rank: 0 },
  laps: 0,
  state: 'solo',
};

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

test("another laptop's status is read when it fits", () => {
  const read = readPeerStatus(status, 'test');
  assert.equal(read.hostId, 'host-b');
  assert.equal(read.split.rank, 0);
});

test('a status that does not fit is refused and logged', (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const broken = { ...status, split: 'split-1', members: null };
  assert.throws(
    () => readPeerStatus(broken, 'http://broken.test'),
    (error) => !(error instanceof PeerVersionError)
  );
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /http:\/\/broken\.test/);
});

test('a status of another version that does not fit says to upgrade', () => {
  assert.throws(
    () => readPeerStatus({ appVersion: '1.0.0', schemaVersion: 1, hostId: 'old' }, 'http://old.test'),
    (error) => error instanceof PeerVersionError && /Upgrade vereist/.test(error.message)
  );
});

test('a forwarded write whose answer does not fit is repeated, not applied', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: 'not an object', error: 42 }));
  });
  const url = await listen(server);
  try {
    const outcome = await forwardWrite({ hostId: 'leader', url }, 'race.handoff', {}, 'request-bad', 'test');
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.retry, true);
  } finally {
    server.close();
  }
});

test('an answer without a value, like a void procedure, still fits', () => {
  assert.equal(trpcAnswerSchema.safeParse({ result: {} }).success, true);
  assert.equal(peerSocketAnswerSchema.safeParse({ id: 1, refused: { code: 'x', error: 'y' } }).success, true);
});

test('bad requests over the peer socket are dropped and the next good one is answered', async (t) => {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const seen: unknown[] = [];
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) =>
    acceptPeerSocket(req, socket, head, (type, body) => {
      seen.push({ type, body });
      return { body: 'ok' };
    })
  );
  const url = await listen(server);
  const client = new WebSocket(`${url.replace('http', 'ws')}/api/cluster/peer`);
  try {
    await new Promise((resolve, reject) => client.once('open', resolve).once('error', reject));
    const replies: unknown[] = [];
    client.on('message', (data) => replies.push(JSON.parse(String(data))));
    client.send('not json');
    client.send(JSON.stringify({ id: 'one', type: 'append', body: {} }));
    client.send(JSON.stringify({ id: 2, type: 'delete-everything', body: {} }));
    client.send(JSON.stringify({ id: 3, type: 'vote', body: { term: 1 } }));
    await new Promise((resolve) => client.once('message', resolve));
    assert.deepEqual(seen, [{ type: 'vote', body: { term: 1 } }]);
    assert.deepEqual(replies, [{ id: 3, body: 'ok' }]);
    assert.ok(warn.mock.callCount() >= 1);
  } finally {
    client.terminate();
    closePeerSockets();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an answer over the peer socket that does not fit is dropped, so the request fails', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const sockets = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) =>
    sockets.handleUpgrade(req, socket, head, (peer) =>
      peer.on('message', (data) => {
        const { id } = JSON.parse(String(data)) as { id: number };
        peer.send(JSON.stringify({ id, refused: 'not an object' }));
      })
    )
  );
  const url = await listen(server);
  try {
    await assert.rejects(peerRequest(url, 'append', {}), /no answer/);
  } finally {
    closePeerSockets();
    for (const peer of sockets.clients) peer.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
