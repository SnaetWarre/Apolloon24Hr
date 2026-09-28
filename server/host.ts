import os from 'node:os';
import type { HostInfo } from '../shared/schemas.js';
import { readPort } from './env.js';

export const SERVER_PORT = readPort(process.env.PORT, 5173);
export const PUBLIC_APP_PORT = readPort(process.env.PUBLIC_APP_PORT, SERVER_PORT);
const EXPLICIT_PUBLIC_HOST = process.env.PUBLIC_HOST?.trim() || null;
const HOST_CACHE_MS = 1_000;

let cachedLanHost: string | null = null;
let cachedLanHostAt = 0;

type LanNetworkEndpoint = {
  address: string;
  broadcastAddress: string;
  score: number;
};

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
    cachedLanHost = currentLanNetworkEndpoints()[0]?.address ?? null;
    cachedLanHostAt = now;
  }
  return cachedLanHost || 'localhost';
}

export function selectLanIp(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string | null {
  return lanNetworkEndpoints(interfaces)[0]?.address ?? null;
}

export function currentLanNetworkEndpoints(): LanNetworkEndpoint[] {
  try {
    return lanNetworkEndpoints(os.networkInterfaces());
  } catch {
    return [];
  }
}

/** Physical IPv4 interfaces, best event-LAN candidate first (wired private ranges win). */
export function lanNetworkEndpoints(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): LanNetworkEndpoint[] {
  const candidates: LanNetworkEndpoint[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addressInfo of addresses ?? []) {
      if (addressInfo.family !== 'IPv4' || addressInfo.internal || !addressInfo.address) continue;
      const score = scoreInterfaceAddress(name, addressInfo.address);
      if (score > 0) {
        candidates.push({
          address: addressInfo.address,
          broadcastAddress: ipv4BroadcastAddress(addressInfo.address, addressInfo.netmask),
          score,
        });
      }
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
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

function ipv4BroadcastAddress(address: string, netmask: string): string {
  const addressParts = address.split('.').map(Number);
  const netmaskParts = netmask.split('.').map(Number);
  if (
    addressParts.length !== 4 ||
    netmaskParts.length !== 4 ||
    [...addressParts, ...netmaskParts].some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return '255.255.255.255';
  }
  return addressParts.map((part, index) => (part & netmaskParts[index]) | (~netmaskParts[index] & 255)).join('.');
}
