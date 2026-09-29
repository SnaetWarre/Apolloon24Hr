import os from 'node:os';
import type { HostInfo } from '../shared/schemas.js';
import { readPort } from './env.js';

export const SERVER_PORT = readPort(process.env.PORT, 5173);
export const PUBLIC_APP_PORT = readPort(process.env.PUBLIC_APP_PORT, SERVER_PORT);
const EXPLICIT_PUBLIC_HOST = process.env.PUBLIC_HOST?.trim() || null;
const HOST_CACHE_MS = 1_000;

let cachedLanHost: string | null = null;
let cachedLanHostAt = 0;

export function hostInfo(): HostInfo {
  const publicHost = resolvePublicHost();
  return {
    hostIpHint: publicHost,
    port: PUBLIC_APP_PORT,
    url: `http://${publicHost}:${PUBLIC_APP_PORT}`,
  };
}

function resolvePublicHost(): string {
  if (EXPLICIT_PUBLIC_HOST) return EXPLICIT_PUBLIC_HOST;
  const now = Date.now();
  if (now - cachedLanHostAt >= HOST_CACHE_MS) {
    try {
      cachedLanHost = selectLanIp(os.networkInterfaces());
    } catch {
      cachedLanHost = null;
    }
    cachedLanHostAt = now;
  }
  return cachedLanHost || 'localhost';
}

/** The physical IPv4 address other laptops most likely reach: wired private ranges win. */
export function selectLanIp(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null {
  let best: { address: string; score: number } | null = null;
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addressInfo of addresses ?? []) {
      if (addressInfo.family !== 'IPv4' || addressInfo.internal || !addressInfo.address) continue;
      const score = scoreInterfaceAddress(name, addressInfo.address);
      if (score > 0 && (!best || score > best.score)) best = { address: addressInfo.address, score };
    }
  }
  return best?.address ?? null;
}

function scoreInterfaceAddress(name: string, address: string): number {
  if (/^(lo|docker|br-|veth|virbr|zt|tailscale|tun|tap|wg|vmnet|vboxnet)/i.test(name)) {
    return -1;
  }

  const [firstPart, secondPart] = address.split('.').map(Number);
  let score = 10;

  if (firstPart === 192 && secondPart === 168) score += 100;
  else if (firstPart === 10) score += 90;
  else if (firstPart === 172 && secondPart >= 16 && secondPart <= 31) score += 90;
  else if (firstPart === 169 && secondPart === 254) score += 5;

  if (/^(en|eth|eno|ens|enp|ethernet)/i.test(name)) score += 200;
  else if (/^(wl|wlan|wifi|wi-fi)/i.test(name)) score += 20;
  return score;
}
