import dgram from 'node:dgram';
import { z } from 'zod';
import { isClusterEnabled, readPositiveInt } from './env.js';
import { DISCOVERY_PORT, PUBLIC_APP_PORT, lanNetworks, laptopName } from './host.js';
import { isIsolated, normalizeUrl, selfUrl } from './peers.js';

/*
 * Every laptop announces itself on the LAN every two seconds with a small UDP
 * broadcast. Laptops of one group use it to find each other again when their
 * addresses change (a new DHCP lease, another router), and a laptop on its
 * own lists the laptops it could join. A broadcast never joins or changes
 * anything by itself.
 */

const enabled = isClusterEnabled() && process.env.CLUSTER_DISCOVERY !== 'false';
/** Tests on one machine broadcast on loopback instead of the LAN. */
const configuredAddress = process.env.CLUSTER_DISCOVERY_ADDRESS?.trim() || null;
const intervalMs = readPositiveInt(process.env.CLUSTER_DISCOVERY_INTERVAL_MS, 2_000);
const forgetAfterMs = intervalMs * 5;
const BROADCAST_ALL = '255.255.255.255';

const beaconSchema = z.object({
  app: z.literal('apolloon'),
  hostId: z.string().min(1).max(128),
  /** The computer name; older versions do not send it. */
  name: z.string().max(256).nullish().transform(laptopName),
  clusterId: z.string().min(1).max(128),
  url: z.string().min(1).max(2_048),
  appVersion: z.string().max(64),
  schemaVersion: z.number().int(),
  leader: z.boolean(),
  groupSize: z.number().int().positive(),
  runners: z.number().int().nonnegative(),
});
export type Beacon = z.infer<typeof beaconSchema>;
export type OwnBeacon = Omit<Beacon, 'app' | 'url'>;

/** What was heard, per laptop and address, since a laptop with two network cards announces on both. */
const heard = new Map<string, Beacon & { heardAt: number }>();
let socket: dgram.Socket | null = null;
let timer: NodeJS.Timeout | null = null;
let describeSelf: (() => OwnBeacon) | null = null;
let ownHostId: string | null = null;

export function startDiscovery(describe: () => OwnBeacon): void {
  if (!enabled || socket) return;
  describeSelf = describe;
  const next = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket = next;
  next.on('error', (error) => {
    console.warn('Laptop discovery stopped, retrying:', error.message);
    closeSocket();
    timer = setTimeout(() => startDiscovery(describe), intervalMs);
    timer.unref();
  });
  next.on('message', (packet) => {
    if (isIsolated()) return;
    try {
      const beacon = beaconSchema.parse(JSON.parse(packet.toString('utf8')));
      const url = normalizeUrl(beacon.url);
      if (!url || beacon.hostId === ownHostId) return;
      heard.set(`${beacon.hostId} ${url}`, { ...beacon, url, heardAt: Date.now() });
    } catch {
      // Unrelated traffic on the port.
    }
  });
  next.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    if (socket !== next) return;
    try {
      next.setBroadcast(true);
    } catch {
      // Some containers do not allow broadcast; the laptops then rely on known addresses.
    }
    announce();
    timer = setInterval(announce, intervalMs);
    timer.unref();
  });
  next.unref();
}

export function stopDiscovery(): void {
  closeSocket();
  describeSelf = null;
}

function closeSocket(): void {
  if (timer) clearInterval(timer);
  timer = null;
  const current = socket;
  socket = null;
  try {
    current?.close();
  } catch {
    // A failed bind can leave the socket closed already.
  }
}

/** Each network card announces its own address on its own network. */
function announce(): void {
  if (!socket || !describeSelf || isIsolated()) return;
  const own = describeSelf();
  ownHostId = own.hostId;
  const networks = configuredAddress || process.env.CLUSTER_SELF_URL ? [] : lanNetworks();
  const targets = networks.length
    ? networks.map((network) => ({
        address: network.broadcastAddress,
        url: `http://${network.address}:${PUBLIC_APP_PORT}`,
      }))
    : [{ address: configuredAddress ?? BROADCAST_ALL, url: selfUrl() }];
  for (const target of targets) {
    const beacon: Beacon = { app: 'apolloon', ...own, url: target.url };
    socket.send(JSON.stringify(beacon), DISCOVERY_PORT, target.address, () => {
      // A network without broadcast just stays quiet.
    });
  }
}

/** Laptops heard recently, one entry per laptop and address. */
export function heardLaptops(): Beacon[] {
  const now = Date.now();
  const fresh: Beacon[] = [];
  for (const [key, { heardAt, ...beacon }] of heard) {
    if (now - heardAt > forgetAfterMs) heard.delete(key);
    else fresh.push(beacon);
  }
  return fresh;
}

/**
 * The address to use for a laptop: the known one while that laptop still
 * announces it (or nothing is heard), otherwise the one it announces now.
 */
export function currentUrl(hostId: string, knownUrl: string): string {
  let latest: { url: string; heardAt: number } | null = null;
  const now = Date.now();
  for (const beacon of heard.values()) {
    if (beacon.hostId !== hostId || now - beacon.heardAt > forgetAfterMs) continue;
    if (beacon.url === knownUrl) return knownUrl;
    if (!latest || beacon.heardAt > latest.heardAt) latest = beacon;
  }
  return latest?.url ?? knownUrl;
}
