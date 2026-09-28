import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { promisify } from 'node:util';
import { gzip, constants as zlibConstants } from 'node:zlib';

const gzipAsync = promisify(gzip);
const MINIMUM_COMPRESSION_BYTES = 1_024;
const MAX_CACHED_RESPONSES = 32;

type CachedResponse = { etag: string; raw: Buffer; compressed: Promise<Buffer> | null };

/** Serialized bodies keyed by the caller's cache key (e.g. data revision), oldest evicted first. */
const responseCache = new Map<string, CachedResponse>();

export async function sendJson(
  req: Request,
  res: Response,
  value: unknown,
  options: { cacheKey?: string; sensitive?: boolean } = {}
): Promise<void> {
  const entry = responseEntry(value, options.cacheKey);
  if (options.cacheKey && req.header('if-none-match') === entry.etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', entry.etag);
  res.setHeader('Cache-Control', options.sensitive ? 'no-store' : 'no-cache');
  res.setHeader('X-Apolloon-Uncompressed-Bytes', String(entry.raw.length));

  const acceptsGzip = req.acceptsEncodings('gzip') === 'gzip';
  if (acceptsGzip && entry.raw.length >= MINIMUM_COMPRESSION_BYTES) {
    entry.compressed ??= gzipAsync(entry.raw, {
      level: zlibConstants.Z_BEST_SPEED,
    });
    const body = await entry.compressed;
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
    return;
  }

  res.setHeader('Content-Length', String(entry.raw.length));
  res.end(entry.raw);
}

/** Request body for a peer, gzipped once it is large enough to be worth it. */
export async function encodedJsonRequest(
  value: unknown
): Promise<{ body: string | Blob; contentEncoding: 'gzip' | null }> {
  const raw = Buffer.from(JSON.stringify(value));
  if (raw.length < MINIMUM_COMPRESSION_BYTES) {
    return { body: raw.toString('utf8'), contentEncoding: null };
  }
  const compressed = await gzipAsync(raw, { level: zlibConstants.Z_BEST_SPEED });
  const body = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength
  ) as ArrayBuffer;
  return { body: new Blob([body], { type: 'application/json' }), contentEncoding: 'gzip' };
}

function responseEntry(value: unknown, cacheKey?: string): CachedResponse {
  if (cacheKey) {
    const cached = responseCache.get(cacheKey);
    if (cached) return cached;
  }
  const raw = Buffer.from(JSON.stringify(value));
  const etag = `"${crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 24)}"`;
  const entry: CachedResponse = { etag, raw, compressed: null };
  if (cacheKey) {
    responseCache.set(cacheKey, entry);
    if (responseCache.size > MAX_CACHED_RESPONSES) {
      responseCache.delete(responseCache.keys().next().value as string);
    }
  }
  return entry;
}
