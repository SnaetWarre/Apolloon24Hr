import os from 'node:os';
import type { HostInfo } from '../shared/schemas.js';
import { readPort } from './env.js';

export const SERVER_PORT = readPort(process.env.PORT, 5173);
export const PUBLIC_APP_PORT = readPort(process.env.PUBLIC_APP_PORT, SERVER_PORT);
/** UDP port on which laptops announce themselves to each other. */
export const DISCOVERY_PORT = readPort(process.env.CLUSTER_DISCOVERY_PORT, 45737);
const EXPLICIT_PUBLIC_HOST = process.env.PUBLIC_HOST?.trim() || null;
const HOST_CACHE_MS = 1_000;
/** This computer's name, which the screens show for a laptop instead of its address. Tests on one machine set their own. */
export const LAPTOP_NAME = laptopName(process.env.CLUSTER_LAPTOP_NAME || os.hostname());

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

/** A computer name as the screens show it: without its network domain, and short enough for a row. */
export function laptopName(raw: string | null | undefined): string | null {
  return raw?.trim().split('.')[0]?.trim().slice(0, 64) || null;
}

function resolvePublicHost(): string {
  if (EXPLICIT_PUBLIC_HOST) return EXPLICIT_PUBLIC_HOST;
  const now = Date.now();
  if (now - cachedLanHostAt >= HOST_CACHE_MS) {
    cachedLanHost = lanAddresses()[0] ?? null;
    cachedLanHostAt = now;
  }
  return cachedLanHost || 'localhost';
}

/** Physical IPv4 addresses other laptops can reach, most likely first: wired private ranges win. */
export function lanAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = safeNetworkInterfaces()): string[] {
  return lanNetworks(interfaces).map((network) => network.address);
}

/** The same addresses with their network's broadcast address. */
export function lanNetworks(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = safeNetworkInterfaces()
): Array<{ address: string; broadcastAddress: string }> {
  const candidates: Array<{ address: string; broadcastAddress: string; score: number }> = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addressInfo of addresses ?? []) {
      if (addressInfo.family !== 'IPv4' || addressInfo.internal || !addressInfo.address) continue;
      const score = scoreInterfaceAddress(name, addressInfo.address);
      if (score <= 0) continue;
      const broadcastAddress = ipv4BroadcastAddress(addressInfo.address, addressInfo.netmask);
      candidates.push({ address: addressInfo.address, broadcastAddress, score });
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score)
    .map(({ address, broadcastAddress }) => ({ address, broadcastAddress }));
}

function ipv4BroadcastAddress(address: string, netmask: string): string {
  const mask = netmask.split('.').map(Number);
  return address
    .split('.')
    .map((part, index) => (Number(part) | (~(mask[index] ?? 0) & 255)).toString())
    .join('.');
}

function safeNetworkInterfaces(): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  try {
    return os.networkInterfaces();
  } catch {
    return {};
  }
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
