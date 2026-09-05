import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';
import type { RequestHandler } from 'express';

const trustedHostnames = new Set([
  'localhost', os.hostname().toLowerCase(), `${os.hostname().toLowerCase()}.local`,
  ...(process.env.APOLLOON_ALLOWED_HOSTS || '').split(','),
  process.env.PUBLIC_HOST || '',
].map((hostname) => hostname.trim().toLowerCase()).filter(Boolean));

function parseHttpAuthority(authority: string): URL | null {
  try {
    const parsed = new URL(`http://${authority}`);
    return !parsed.username && !parsed.password && parsed.pathname === '/' &&
      !parsed.search && !parsed.hash ? parsed : null;
  } catch {
    return null;
  }
}

export function browserRequestIsAllowed(request: IncomingMessage): boolean {
  const authority = request.headers.host;
  const destination = authority ? parseHttpAuthority(authority) : null;
  if (!destination) return false;
  const hostname = destination.hostname.toLowerCase();
  // Literal IPs cannot be rebound through DNS. Named deployments must be
  // explicit so an attacker's hostname cannot become a local app origin.
  if (!isIP(hostname.replace(/^\[|\]$/g, '')) && !trustedHostnames.has(hostname)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true; // Native peers and CLI clients.
  if (typeof origin !== 'string' || origin === 'null') return false;
  try {
    const source = new URL(origin);
    return (source.protocol === 'http:' || source.protocol === 'https:') &&
      !source.username && !source.password && source.origin === origin &&
      source.host === destination.host;
  } catch {
    return false;
  }
}

export const protectBrowserRequests: RequestHandler = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  if (!browserRequestIsAllowed(req)) {
    res.status(403).json({ ok: false, error: 'request origin or host is not allowed' });
    return;
  }
  next();
};
