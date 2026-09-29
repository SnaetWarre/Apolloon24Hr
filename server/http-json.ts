import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { promisify } from 'node:util';
import { gzip, constants as zlibConstants } from 'node:zlib';

const gzipAsync = promisify(gzip);
const MINIMUM_COMPRESSION_BYTES = 1_024;
const MAX_CACHED_RESPONSES = 32;

type Body = { etag: string; raw: Buffer; compressed: Promise<Buffer> | null };

/** Serialized bodies by cache key (e.g. the data revision), oldest evicted first. */
const responseCache = new Map<string, Body>();

/**
 * Sends JSON with an ETag and gzip. With a `cacheKey`, `build` runs once per
 * key, so every client asking for the same revision shares one serialization.
 */
export async function sendJson(
  req: Request,
  res: Response,
  cacheKey: string | null,
  build: () => unknown
): Promise<void> {
  const body = cacheKey ? cachedBody(cacheKey, build) : createBody(build());
  if (req.header('if-none-match') === body.etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('ETag', body.etag);
  res.setHeader('Cache-Control', 'no-cache');

  if (req.acceptsEncodings('gzip') === 'gzip' && body.raw.length >= MINIMUM_COMPRESSION_BYTES) {
    body.compressed ??= gzipAsync(body.raw, {
      level: zlibConstants.Z_BEST_SPEED,
    });
    const compressed = await body.compressed;
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', String(compressed.length));
    res.end(compressed);
    return;
  }

  res.setHeader('Content-Length', String(body.raw.length));
  res.end(body.raw);
}

function cachedBody(cacheKey: string, build: () => unknown): Body {
  const cached = responseCache.get(cacheKey);
  if (cached) return cached;
  const body = createBody(build());
  responseCache.set(cacheKey, body);
  if (responseCache.size > MAX_CACHED_RESPONSES) responseCache.delete(responseCache.keys().next().value as string);
  return body;
}

function createBody(value: unknown): Body {
  const raw = Buffer.from(JSON.stringify(value));
  const etag = `"${crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 24)}"`;
  return { etag, raw, compressed: null };
}
