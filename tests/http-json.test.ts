import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { sendJson } from '../server/http-json.ts';
import { readClusterResponseJson, readClusterResponseText } from '../server/cluster-http.ts';

test('cluster responses enforce declared and streamed byte limits and cancel oversized streams', async () => {
  for (const contentLength of [undefined, '100']) {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(6)); },
      cancel() { canceled = true; },
    });
    const response = new Response(body, { headers: contentLength ? { 'content-length': contentLength } : {} });
    await assert.rejects(readClusterResponseText(response, 5), /byte limit/);
    assert.equal(canceled, true);
  }
  assert.deepEqual(await readClusterResponseJson(new Response('{"label":"€"}')), { label: '€' });
});

test('JSON caches replace revisions, enforce a byte budget and preserve revalidation headers', async () => {
  const app = express();
  let serializationCount = 0;
  app.get('/json', async (req, res) => {
    const revision = String(req.query.revision || '1');
    const cacheSlot = String(req.query.slot || 'fixture');
    const size = req.query.large ? 2 * 1_024 ** 2 : 100;
    await sendJson(req, res, { toJSON: () => {
      serializationCount += 1;
      return { revision, content: 'x'.repeat(size) };
    } }, { cacheKey: `${cacheSlot}:${revision}`, cacheSlot });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const requestJson = async (query: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${baseUrl}/json?${query}`, { headers });
    const body = await response.text();
    return { response, body };
  };
  try {
    const first = await requestJson('revision=1');
    const cached = await requestJson('revision=1');
    assert.equal(serializationCount, 1);
    assert.equal(cached.body, first.body);
    await requestJson('revision=2');
    await requestJson('revision=1');
    assert.equal(serializationCount, 3, 'an obsolete revision must not stay retained in the same slot');

    // Use a raw HTTP request because fetch can add Cache-Control: no-cache to
    // conditional requests, which deliberately requires a fresh 200 response.
    const revalidated = await new Promise<{ status?: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http.get(`${baseUrl}/json?revision=1`, { headers: { 'if-none-match': first.response.headers.get('etag')! } }, (response) => {
        response.resume();
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
      }).on('error', reject);
    });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.vary, 'Accept-Encoding');
    assert.equal(revalidated.headers['cache-control'], 'private, no-cache');
    assert.equal(revalidated.headers.etag, first.response.headers.get('etag'));

    await requestJson('slot=large-0&large=1');
    for (let slot = 1; slot <= 9; slot += 1) await requestJson(`slot=large-${slot}&large=1`);
    const countBeforeRevisit = serializationCount;
    await requestJson('slot=large-0&large=1');
    assert.equal(serializationCount, countBeforeRevisit + 1, 'byte budget must evict before the 32-entry limit');
    const countBeforeCacheHit = serializationCount;
    await requestJson('slot=large-0&large=1', { 'accept-encoding': 'gzip' });
    assert.equal(serializationCount, countBeforeCacheHit);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
