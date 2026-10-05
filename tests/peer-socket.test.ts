import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import {
  acceptPeerSocket,
  closePeerSockets,
  peerRequest,
  refusal,
  refuseUpgrade,
  type PeerAnswer,
} from '../server/peer-socket.ts';

/** Takes sockets but never answers, like a laptop with its lid closed. */
const asleep = new WebSocketServer({ noServer: true });

/** A laptop that answers every peer request with `answer`, refuses the socket with `refuseWith`, or sleeps. */
async function fakeLaptop(options: {
  answer?: (type: unknown, body: unknown) => PeerAnswer;
  refuseWith?: number;
  sleeping?: () => boolean;
}) {
  let upgrades = 0;
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    upgrades += 1;
    if (options.sleeping?.()) asleep.handleUpgrade(req, socket, head, () => undefined);
    else if (options.refuseWith) refuseUpgrade(socket, options.refuseWith, 'refused', 'refused');
    else acceptPeerSocket(req, socket, head, options.answer ?? (() => ({ body: null })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    upgrades: () => upgrades,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test.after(() => {
  for (const socket of asleep.clients) socket.terminate();
});

test('requests share one socket and each gets its own answer', async () => {
  const laptop = await fakeLaptop({ answer: (type, body) => ({ body: { type, echo: body } }) });
  try {
    const answers = await Promise.all([
      peerRequest(laptop.url, 'append', { n: 1 }),
      peerRequest(laptop.url, 'vote', { n: 2 }),
      peerRequest(laptop.url, 'append', { n: 3 }),
    ]);
    assert.deepEqual(answers, [
      { type: 'append', echo: { n: 1 } },
      { type: 'vote', echo: { n: 2 } },
      { type: 'append', echo: { n: 3 } },
    ]);
    assert.deepEqual(await peerRequest(laptop.url, 'append', { n: 4 }), { type: 'append', echo: { n: 4 } });
    assert.equal(laptop.upgrades(), 1);
  } finally {
    closePeerSockets();
    await laptop.close();
  }
});

test('a refused request or socket resolves null, like a refused HTTP request', async () => {
  const refusing = await fakeLaptop({ answer: () => refusal('cluster_mismatch', 'andere groep') });
  const otherVersion = await fakeLaptop({ refuseWith: 426 });
  try {
    assert.equal(await peerRequest(refusing.url, 'append', {}), null);
    assert.equal(await peerRequest(otherVersion.url, 'vote', {}), null);
  } finally {
    closePeerSockets();
    await Promise.all([refusing.close(), otherVersion.close()]);
  }
});

test('an unreachable laptop rejects', async () => {
  const laptop = await fakeLaptop({});
  await laptop.close();
  await assert.rejects(peerRequest(laptop.url, 'append', {}));
});

test('a laptop that stops answering rejects in time, and is reached again on a fresh socket', async () => {
  let sleeping = true;
  const laptop = await fakeLaptop({ answer: () => ({ body: 'awake' }), sleeping: () => sleeping });
  try {
    const startedAt = performance.now();
    await assert.rejects(peerRequest(laptop.url, 'append', {}), /no answer/);
    assert.ok(performance.now() - startedAt < 2_000);
    sleeping = false;
    assert.equal(await peerRequest(laptop.url, 'append', {}), 'awake');
    assert.equal(laptop.upgrades(), 2);
  } finally {
    closePeerSockets();
    await laptop.close();
  }
});
