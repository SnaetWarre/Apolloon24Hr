import os from 'os';
import type { HostInfo } from '../shared/schemas.js';

export const SERVER_PORT = readPort(process.env.PORT, 5173);
export const PUBLIC_APP_PORT = readPort(process.env.PUBLIC_APP_PORT, SERVER_PORT);
export const PUBLIC_HOST = resolvePublicHost();

export function readPort(value: unknown, fallback: number): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

export function hostInfo(): HostInfo {
  return {
    hostIpHint: PUBLIC_HOST,
    port: PUBLIC_APP_PORT,
    url: `http://${PUBLIC_HOST}:${PUBLIC_APP_PORT}`,
  };
}

function resolvePublicHost(): string {
  if (process.env.PUBLIC_HOST) return process.env.PUBLIC_HOST;
  return detectLanIp() || 'localhost';
}

function detectLanIp(): string | null {
  let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return null;
  }

  const candidates: Array<{ address: string; score: number }> = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addressInfo of addresses || []) {
      const family = addressInfo.family === 'IPv4';
      if (!family || addressInfo.internal || !addressInfo.address) continue;
      const score = scoreInterfaceAddress(name, addressInfo.address);
      if (score > 0) candidates.push({ address: addressInfo.address, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || null;
}

function scoreInterfaceAddress(name: string, address: string): number {
  if (/^(lo|docker|br-|veth|virbr|zt|tailscale|tun|tap|wg|vmnet|vboxnet)/i.test(name)) {
    return -1;
  }

  const [firstPart, secondPart] = address.split('.').map((part) => Number(part));
  let score = 10;

  if (firstPart === 192 && secondPart === 168) score += 100;
  else if (firstPart === 10) score += 90;
  else if (firstPart === 172 && secondPart >= 16 && secondPart <= 31) score += 90;
  else if (firstPart === 169 && secondPart === 254) score += 5;

  if (/^(en|eth|eno|ens|enp|wl|wlan|wifi|wi-fi)/i.test(name)) score += 20;
  return score;
}
