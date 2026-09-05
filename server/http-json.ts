import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { promisify } from 'node:util';
import { gzip, constants as zlibConstants } from 'node:zlib';

const gzipAsync = promisify(gzip);
const MINIMUM_COMPRESSION_BYTES = 1_024;
const MAXIMUM_RESPONSE_CACHE_BYTES = 32 * 1_024 ** 2;
type CachedResponse = {
  cacheKey: string | undefined;
  etag: string | null;
  raw: Buffer;
  compressed: Promise<Buffer> | null;
};
let reservedCacheBytes = 0;
const responseCache = new Map<
  string,
  CachedResponse
>();

export async function sendJson(
  req: Request,
  res: Response,
  payload: unknown,
  options: { cacheKey?: string; cacheSlot?: string; sensitive?: boolean } = {}
): Promise<void> {
  const entry = responseEntry(payload, options.sensitive ? undefined : options.cacheKey, options.cacheSlot);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  if (entry.etag) res.setHeader('ETag', entry.etag);
  res.setHeader('Cache-Control', options.sensitive ? 'no-store' : 'private, no-cache');
  if (entry.etag && req.fresh) {
    res.status(304).end();
    return;
  }
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

export async function encodedJsonRequest(value: unknown): Promise<{
  body: string | Blob;
  contentEncoding: 'gzip' | null;
  uncompressedBytes: number;
}> {
  const raw = Buffer.from(JSON.stringify(value));
  if (raw.length < MINIMUM_COMPRESSION_BYTES) {
    return { body: raw.toString('utf8'), contentEncoding: null, uncompressedBytes: raw.length };
  }
  const compressed = await gzipAsync(raw, { level: zlibConstants.Z_BEST_SPEED });
  const body = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength
  ) as ArrayBuffer;
  return {
    body: new Blob([body], { type: 'application/json' }),
    contentEncoding: 'gzip',
    uncompressedBytes: raw.length,
  };
}

function responseEntry(
  payload: unknown,
  cacheKey?: string,
  cacheSlot = cacheKey
): CachedResponse {
  if (cacheKey) {
    const cached = responseCache.get(cacheSlot!);
    if (cached?.cacheKey === cacheKey) {
      responseCache.delete(cacheSlot!);
      responseCache.set(cacheSlot!, cached);
      return cached;
    }
    evictResponse(cacheSlot!);
  }
  const raw = Buffer.from(JSON.stringify(payload));
  const etag = cacheKey
    ? `"${crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 24)}"`
    : null;
  const entry = { cacheKey, etag, raw, compressed: null };
  // Reserve room for both raw JSON and gzip (including gzip framing). Large
  // individual responses still work, but cannot evict the whole cache.
  const reservedBytes = raw.length * 3 + 1_024;
  if (cacheKey && reservedBytes <= MAXIMUM_RESPONSE_CACHE_BYTES / 2) {
    while (responseCache.size >= 32 || reservedCacheBytes + reservedBytes > MAXIMUM_RESPONSE_CACHE_BYTES) {
      evictResponse(responseCache.keys().next().value!);
    }
    responseCache.set(cacheSlot!, entry);
    reservedCacheBytes += reservedBytes;
  }
  return entry;
}

function evictResponse(cacheSlot: string): void {
  const cached = responseCache.get(cacheSlot);
  if (!cached) return;
  reservedCacheBytes -= cached.raw.length * 3 + 1_024;
  responseCache.delete(cacheSlot);
}
