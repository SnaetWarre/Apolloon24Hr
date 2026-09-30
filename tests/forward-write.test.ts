import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { forwardWrite } from '../server/cluster.ts';

/** A laptop that answers every forwarded write with `status` and `body`. */
async function fakeLaptop(status: number, body: unknown): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('a write that reaches a laptop that no longer leads is repeated at the next leader', async () => {
  // What the /trpc guard in cluster.ts answers when the leader stepped down meanwhile.
  const laptop = await fakeLaptop(409, { ok: false, code: 'not_leader', error: 'Deze laptop is niet de hoofdlaptop.' });
  try {
    const outcome = await forwardWrite(
      { hostId: 'old-leader', url: laptop.url },
      'race.handoff',
      {},
      'request-1',
      'test'
    );
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.retry, true);
  } finally {
    laptop.close();
  }
});

test('a refusal from the leader itself is not repeated', async () => {
  const laptop = await fakeLaptop(409, {
    error: { message: 'Timingstatus is gewijzigd.', data: { code: 'CONFLICT' } },
  });
  try {
    const outcome = await forwardWrite({ hostId: 'leader', url: laptop.url }, 'race.handoff', {}, 'request-2', 'test');
    assert.deepEqual(outcome, { ok: false, code: 'CONFLICT', message: 'Timingstatus is gewijzigd.', retry: false });
  } finally {
    laptop.close();
  }
});
