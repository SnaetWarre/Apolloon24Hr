import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { ClusterStatus } from '../shared/schemas.js';
import { backupStatus, createVerifiedBackup } from './backups.js';
import {
  clusterClockOffset,
  clusterNow,
  observeReferenceClock,
  resetClockSamples,
  setClusterClockOffset,
} from './clock.js';
import {
  DATABASE_SCHEMA_VERSION,
  applyLogEntries,
  canContinueFrom,
  deleteLocalSetting,
  getClusterEpoch,
  getLogEntriesAfter,
  getLogHead,
  getSetting,
  hostIdentity,
  installDatabaseImage,
  replicationLogEntrySchema,
  serializeDatabase,
  setLocalSetting,
} from './db.js';
import { APP_VERSION, isClusterEnabled, readPositiveInt } from './env.js';
import { hostInfo } from './host.js';
import { sendJson } from './http-json.js';

/*
 * One primary laptop commits every write and appends it to its replication
 * log. Standbys pull that log and replay it, so each holds a full copy, and
 * pass the writes made on their own screens on to the primary. Promoting a
 * standby is an operator decision: planned (the primary hands over and stops
 * writing) or, when the primary is gone, an emergency takeover. A primary that
 * learns of a newer primary becomes its standby; if it wrote anything in the
 * meantime it re-syncs, and those writes survive only in the backup taken
 * just before.
 */

const enabled = isClusterEnabled();
const configuredSelfUrl = normalizeUrl(process.env.CLUSTER_SELF_URL);
const pullIntervalMs = readPositiveInt(process.env.CLUSTER_PULL_INTERVAL_MS, 250);
const probeIntervalMs = readPositiveInt(process.env.CLUSTER_PROBE_INTERVAL_MS, 3_000);
const requestTimeoutMs = readPositiveInt(process.env.CLUSTER_REQUEST_TIMEOUT_MS, 2_000);
const reachableWindowMs = Math.max(3_000, pullIntervalMs * 8);
const HANDOVER_MAX_LAG = 500;
const MAX_MEMBERS = 16;
const FORWARD_TIMEOUT_MS = 5_000;

type Busy = ClusterStatus['busy'];

type StandbyRecord = {
  hostId: string;
  url: string;
  appliedSeq: number;
  lastSeenAt: number;
};

const standbys = new Map<string, StandbyRecord>();
let primaryContact = {
  hostId: null as string | null,
  head: 0,
  lastContactAt: null as number | null,
};
let busy: Busy = null;
let lastError: string | null = null;
let competingPrimaryUrl: string | null = null;
let pullTimer: NodeJS.Timeout | null = null;
/** Pulls run one at a time, whether from the timer or after forwarding a write. */
let pullQueue: Promise<unknown> = Promise.resolve();
let probeTimer: NodeJS.Timeout | null = null;
let stopping = false;

const peerRequestSchema = z.object({
  clusterId: z.string().min(1).max(128),
  hostId: z.string().min(1).max(128),
  url: z.string().min(1).max(2_048),
  after: z.number().int().nonnegative(),
  afterId: z.string().max(128).nullable(),
});

const pullResponseSchema = z.object({
  hostId: z.string(),
  clusterId: z.string(),
  epoch: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(),
  entries: z.array(replicationLogEntrySchema),
  members: z.record(z.string(), z.string()),
  serverNowMs: z.number(),
});

const handoverResponseSchema = pullResponseSchema.pick({
  hostId: true,
  epoch: true,
  head: true,
  entries: true,
});

const peerErrorSchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  primaryUrl: z.string().nullable().optional(),
});

// Role and membership are host-local settings, so they survive restarts.

function role(): ClusterStatus['role'] {
  return enabled && getSetting('cluster_role') === 'standby' ? 'standby' : 'primary';
}

function primaryUrl(): string | null {
  return role() === 'standby' ? getSetting('cluster_primary_url') : null;
}

/** True when writes made here are passed on to another laptop. */
export function isFollowing(): boolean {
  return role() === 'standby';
}

function becomeStandby(url: string): void {
  setLocalSetting('cluster_role', 'standby');
  setLocalSetting('cluster_primary_url', url);
  standbys.clear();
  resetClockSamples();
  primaryContact = { hostId: null, head: 0, lastContactAt: null };
  competingPrimaryUrl = null;
}

function becomePrimary(epoch: number): void {
  deleteLocalSetting('cluster_role');
  deleteLocalSetting('cluster_primary_url');
  setLocalSetting('cluster_epoch', String(epoch));
  primaryContact = { hostId: null, head: 0, lastContactAt: null };
  lastError = null;
}

function adoptEpoch(epoch: number): void {
  if (epoch > getClusterEpoch()) setLocalSetting('cluster_epoch', String(epoch));
}

/** Other laptops in this cluster by host id; used to find the primary again after a failover. */
function knownMembers(): Record<string, string> {
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(getSetting('cluster_members_json') || '{}'));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function rememberMembers(members: Record<string, string>): void {
  const selfId = hostIdentity().hostId;
  const current = knownMembers();
  const next = { ...current };
  for (const [hostId, url] of Object.entries(members)) {
    const normalized = normalizeUrl(url);
    if (hostId !== selfId && normalized && normalized !== selfUrl()) next[hostId] = normalized;
  }
  const entries = Object.entries(next).slice(-MAX_MEMBERS);
  if (JSON.stringify(entries) !== JSON.stringify(Object.entries(current))) {
    setLocalSetting('cluster_members_json', JSON.stringify(Object.fromEntries(entries)));
  }
}

export function clusterStatus(): ClusterStatus {
  const identity = hostIdentity();
  const currentRole = role();
  const now = Date.now();
  const head = getLogHead().seq;
  const members = knownMembers();
  const primaryReachable =
    primaryContact.lastContactAt !== null && now - primaryContact.lastContactAt < reachableWindowMs;
  return {
    enabled,
    hostId: identity.hostId,
    clusterId: identity.clusterId,
    role: currentRole,
    epoch: getClusterEpoch(),
    appVersion: APP_VERSION,
    schemaVersion: DATABASE_SCHEMA_VERSION,
    writable: !busy && (currentRole === 'primary' || primaryReachable),
    busy,
    selfUrl: selfUrl(),
    logHead: head,
    primary:
      currentRole === 'standby'
        ? {
            url: primaryUrl(),
            hostId: primaryContact.hostId,
            reachable: primaryReachable,
            lastContactAt: primaryContact.lastContactAt,
            head: primaryContact.head,
            lagEntries: Math.max(0, primaryContact.head - head),
          }
        : null,
    standbys:
      currentRole === 'primary'
        ? [...standbys.values()].map((standby) => ({
            ...standby,
            reachable: now - standby.lastSeenAt < reachableWindowMs,
            caughtUp: standby.appliedSeq >= head,
          }))
        : [],
    memberUrls: [...new Set(Object.values(members))],
    competingPrimaryUrl,
    lastError,
    backup: backupStatus(),
  };
}

/** Throws when this laptop cannot commit a write itself right now. */
export function assertWritable(): void {
  if (role() === 'standby') throw new Error('Deze laptop geeft wijzigingen door aan de primaire laptop.');
  if (busy) throw new Error('Deze laptop wordt gekoppeld of gesynchroniseerd. Probeer zo opnieuw.');
}

type ForwardOutcome<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

/**
 * Passes a write made on this laptop's screen to the primary, then waits
 * until this laptop's copy has it, so the screen shows the result at once.
 */
export async function forwardWrite<T>(path: string, input: unknown): Promise<ForwardOutcome<T>> {
  const url = primaryUrl();
  const unreachable: ForwardOutcome<T> = {
    ok: false,
    code: 'SERVICE_UNAVAILABLE',
    message: 'De primaire laptop is niet bereikbaar. Probeer zo opnieuw, of neem over in Beheer › Systeem.',
  };
  if (!url) return unreachable;
  let response: globalThis.Response;
  try {
    response = await fetch(`${url}/trpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-apolloon-forwarded': '1' },
      body: input === undefined ? undefined : JSON.stringify(input),
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
  } catch {
    return unreachable;
  }
  const payload = (await response.json().catch(() => null)) as {
    result?: { data?: T };
    error?: { message?: string; data?: { code?: string } };
  } | null;
  if (payload?.error) {
    return {
      ok: false,
      code: payload.error.data?.code ?? 'INTERNAL_SERVER_ERROR',
      message: payload.error.message ?? 'Opslaan mislukt',
    };
  }
  if (!response.ok || !payload?.result) {
    return {
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: `De primaire laptop antwoordde met HTTP ${response.status}.`,
    };
  }
  await catchUp().catch(() => undefined);
  return { ok: true, data: payload.result.data as T };
}

/** Pulls until this laptop has everything the primary had when it answered. */
async function catchUp(): Promise<void> {
  for (let batch = 0; batch < 20 && (await pullExclusive()); batch += 1);
}

function pullExclusive(): Promise<boolean> {
  const pull = pullQueue.then(() => (role() === 'standby' && !busy ? pullOnce() : false));
  pullQueue = pull.catch(() => undefined);
  return pull;
}

export function registerClusterRoutes(app: Express): void {
  app.get('/api/cluster/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(clusterStatus());
  });
  if (!enabled) return;

  app.use(['/api/cluster/pull', '/api/cluster/snapshot', '/api/cluster/handover'], requireSameVersion);

  app.post('/api/cluster/pull', (req, res, next) => {
    const request = parsePeerRequest(req, res);
    if (!request) return;
    const identity = hostIdentity();
    const url = normalizeUrl(request.url);
    standbys.set(request.hostId, {
      hostId: request.hostId,
      url,
      appliedSeq: request.after,
      lastSeenAt: Date.now(),
    });
    rememberMembers({ [request.hostId]: url });
    sendJson(req, res, null, () => ({
      hostId: identity.hostId,
      clusterId: identity.clusterId,
      epoch: getClusterEpoch(),
      head: getLogHead().seq,
      entries: getLogEntriesAfter(request.after),
      members: { ...knownMembers(), [identity.hostId]: selfUrl() },
      serverNowMs: clusterNow(),
    })).catch(next);
  });

  app.get('/api/cluster/snapshot', (_req, res) => {
    if (role() !== 'primary' || busy) {
      sendPeerError(res, 409, 'not_primary', 'Deze laptop is niet primair.');
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Apolloon-Epoch', String(getClusterEpoch()));
    res.end(serializeDatabase());
  });

  app.post('/api/cluster/handover', (req, res) => {
    const request = parsePeerRequest(req, res, { allowRepeatedHandover: true });
    if (!request) return;
    const head = getLogHead().seq;
    if (head - request.after > HANDOVER_MAX_LAG) {
      sendPeerError(
        res,
        409,
        'lagging',
        `De standby loopt nog ${head - request.after} wijzigingen achter. Wacht even.`
      );
      return;
    }
    // From here on this laptop stops accepting writes; the caller promotes itself.
    if (role() === 'primary') becomeStandby(normalizeUrl(request.url));
    res.json({
      hostId: hostIdentity().hostId,
      epoch: getClusterEpoch(),
      head,
      entries: getLogEntriesAfter(request.after, HANDOVER_MAX_LAG),
    });
  });
}

/** Validates a standby's request to the primary; answers and returns null when it cannot be served. */
function parsePeerRequest(
  req: Request,
  res: Response,
  options: { allowRepeatedHandover?: boolean } = {}
): z.infer<typeof peerRequestSchema> | null {
  const parsed = peerRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendPeerError(res, 400, 'invalid_request', 'Ongeldig synchronisatieverzoek.');
    return null;
  }
  const request = parsed.data;
  // A handover whose response was lost is repeated; the old primary already follows the caller.
  const repeatedHandover = options.allowRepeatedHandover && primaryUrl() === normalizeUrl(request.url);
  if ((role() !== 'primary' || busy) && !repeatedHandover) {
    sendPeerError(res, 409, 'not_primary', 'Deze laptop is niet primair.', {
      primaryUrl: primaryUrl(),
    });
    return null;
  }
  if (request.clusterId !== hostIdentity().clusterId) {
    sendPeerError(
      res,
      409,
      'cluster_mismatch',
      'Deze laptops horen bij een andere cluster. Koppel de standby opnieuw.'
    );
    return null;
  }
  if (!canContinueFrom(request.after, request.afterId)) {
    sendPeerError(res, 409, 'bootstrap_required', 'De standby moet opnieuw volledig synchroniseren.');
    return null;
  }
  return request;
}

function requireSameVersion(req: Request, res: Response, next: NextFunction): void {
  const appVersion = req.header('x-apolloon-app-version') || 'onbekend';
  const schemaVersion = Number(req.header('x-apolloon-schema-version'));
  if (appVersion === APP_VERSION && schemaVersion === DATABASE_SCHEMA_VERSION) {
    next();
    return;
  }
  sendPeerError(res, 426, 'upgrade_required', versionMismatchMessage(appVersion));
}

function versionMismatchMessage(otherVersion: string): string {
  return `Upgrade vereist: deze laptop draait Apolloon ${APP_VERSION}, de andere ${otherVersion}. Installeer overal dezelfde versie.`;
}

function sendPeerError(
  res: Response,
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {}
): void {
  res.status(status).json({ ok: false, code, error, ...extra });
}

export function startClusterService(): void {
  const storedOffset = Number(getSetting('cluster_clock_offset_ms') || 0);
  setClusterClockOffset(Number.isFinite(storedOffset) ? storedOffset : 0);
  if (!enabled) return;
  stopping = false;
  schedulePull(0);
  probeTimer = setInterval(() => void probeMembers(), probeIntervalMs);
  probeTimer.unref();
}

export function stopClusterService(): void {
  stopping = true;
  if (pullTimer) clearTimeout(pullTimer);
  if (probeTimer) clearInterval(probeTimer);
  pullTimer = null;
  probeTimer = null;
}

function schedulePull(delayMs: number): void {
  if (stopping) return;
  pullTimer = setTimeout(async () => {
    let more = false;
    try {
      more = await pullExclusive();
    } catch (error) {
      lastError = errorMessage(error);
    } finally {
      schedulePull(more ? 0 : pullIntervalMs);
    }
  }, delayMs);
  pullTimer.unref();
}

/** Fetches and replays the next batch; true when the primary has more waiting. */
async function pullOnce(): Promise<boolean> {
  const url = primaryUrl();
  if (!url) {
    lastError = 'Deze standby weet niet welke laptop primair is. Koppel opnieuw in Beheer.';
    return false;
  }
  const identity = hostIdentity();
  const head = getLogHead();
  const startedAt = Date.now();
  const response = await peerFetch(`${url}/api/cluster/pull`, {
    method: 'POST',
    body: {
      clusterId: identity.clusterId,
      hostId: identity.hostId,
      url: selfUrl(),
      after: head.seq,
      afterId: head.id,
    },
  }).catch(() => null);
  if (!response) return false;

  if (!response.ok) {
    const problem = await readPeerError(response);
    if (problem.code === 'bootstrap_required') {
      await resync(url);
      return true;
    }
    if (problem.code === 'not_primary' && problem.primaryUrl && normalizeUrl(problem.primaryUrl) !== selfUrl()) {
      becomeStandby(normalizeUrl(problem.primaryUrl));
      return true;
    }
    lastError = problem.error || `De primaire laptop antwoordde met HTTP ${response.status}.`;
    return false;
  }

  const payload = pullResponseSchema.parse(await response.json());
  const receivedAt = Date.now();
  try {
    applyLogEntries(payload.entries.filter((entry) => entry.seq > getLogHead().seq));
  } catch (error) {
    // A standby's copy is disposable: rather than stall, fetch a fresh one.
    console.warn('Standby could not replay the primary log; resynchronizing:', errorMessage(error));
    await resync(url);
    return true;
  }
  adoptEpoch(payload.epoch);
  rememberMembers({ ...payload.members, [payload.hostId]: url });
  primaryContact = {
    hostId: payload.hostId,
    head: payload.head,
    lastContactAt: receivedAt,
  };
  if (observeReferenceClock(payload.serverNowMs, startedAt, receivedAt)) {
    setLocalSetting('cluster_clock_offset_ms', String(clusterClockOffset()));
  }
  lastError = null;
  return getLogHead().seq < payload.head;
}

async function resync(url: string): Promise<void> {
  busy = 'bootstrapping';
  try {
    await bootstrapFrom(url, 'pre-standby-resync');
  } finally {
    busy = null;
  }
}

/** Replaces this laptop's data with the primary's, after a backup of what it had. */
async function bootstrapFrom(url: string, backupReason: string): Promise<string> {
  const response = await peerFetch(`${url}/api/cluster/snapshot`, {
    timeoutMs: 60_000,
  });
  if (!response.ok) {
    throw new Error((await readPeerError(response)).error || `Database ophalen mislukt (HTTP ${response.status}).`);
  }
  const epoch = Number(response.headers.get('x-apolloon-epoch') || 0);
  const image = Buffer.from(await response.arrayBuffer());
  const backup = await createVerifiedBackup(backupReason);
  installDatabaseImage(image, DATABASE_SCHEMA_VERSION);
  setLocalSetting('cluster_epoch', String(Number.isSafeInteger(epoch) ? epoch : 0));
  return backup.fileName;
}

/**
 * A primary checks that no other laptop has been promoted past it; a standby
 * that lost its primary looks for whichever laptop is primary now.
 */
async function probeMembers(): Promise<void> {
  if (busy || stopping) return;
  const currentRole = role();
  const lastContact = primaryContact.lastContactAt;
  if (currentRole === 'standby' && lastContact !== null && Date.now() - lastContact < probeIntervalMs) return;

  const identity = hostIdentity();
  const statuses = await Promise.all(
    Object.values(knownMembers()).map(async (url) => ({
      url,
      status: await fetchStatus(url).catch(() => null),
    }))
  );
  const primaries = statuses.filter(
    (entry): entry is { url: string; status: ClusterStatus } =>
      Boolean(entry.status) &&
      entry.status!.enabled &&
      entry.status!.role === 'primary' &&
      entry.status!.clusterId === identity.clusterId &&
      entry.status!.hostId !== identity.hostId
  );
  if (busy || role() !== currentRole) return;
  const epoch = getClusterEpoch();
  const newest = primaries.sort((a, b) => b.status.epoch - a.status.epoch)[0];

  if (currentRole === 'primary') {
    if (newest && newest.status.epoch > epoch) {
      becomeStandby(newest.url);
      lastError = `${newest.url} is intussen primair geworden. Deze laptop volgt die nu als standby.`;
      return;
    }
    competingPrimaryUrl = primaries.find((entry) => entry.status.epoch === epoch)?.url ?? null;
    return;
  }
  if (newest && newest.status.epoch >= epoch && newest.url !== primaryUrl()) becomeStandby(newest.url);
}

/** Makes this laptop a standby of the primary at `rawUrl`, replacing its data. */
export async function joinPrimary(rawUrl: string): Promise<{ backupFile: string }> {
  if (!enabled) throw new Error('Laptops koppelen staat uit op deze installatie.');
  const url = normalizeUrl(rawUrl);
  if (!url || url === selfUrl()) throw new Error('Vul het adres van de primaire laptop in.');
  if (busy) throw new Error('Er loopt al een koppeling of synchronisatie.');
  busy = 'joining';
  try {
    const status = await fetchStatus(url).catch(() => {
      throw new Error(`${url} is niet bereikbaar. Controleer het adres en de kabel.`);
    });
    if (!status.enabled) throw new Error('Op die laptop staat laptops koppelen uit.');
    if (status.hostId === hostIdentity().hostId) throw new Error('Dat adres is deze laptop zelf.');
    if (status.appVersion !== APP_VERSION || status.schemaVersion !== DATABASE_SCHEMA_VERSION) {
      throw new Error(versionMismatchMessage(status.appVersion));
    }
    if (status.role !== 'primary') {
      throw new Error(
        `Die laptop is standby. Koppel met de primaire laptop${status.primary?.url ? `: ${status.primary.url}` : ''}.`
      );
    }
    const backupFile = await bootstrapFrom(url, 'pre-join');
    becomeStandby(url);
    setLocalSetting('cluster_members_json', '{}');
    rememberMembers({ [status.hostId]: url });
    lastError = null;
    return { backupFile };
  } finally {
    busy = null;
  }
}

/**
 * Promotes this standby. With a reachable primary this is a planned handover
 * without data loss; otherwise only `emergency` promotes, accepting that the
 * primary's last unsynchronized writes may be missing.
 */
export async function promoteToPrimary(
  emergency: boolean
): Promise<{ result: 'planned' | 'emergency' | 'primary-unreachable' }> {
  if (!enabled || role() !== 'standby') throw new Error('Deze laptop is al primair.');
  if (busy) throw new Error('Er loopt al een koppeling of synchronisatie.');
  busy = 'promoting';
  try {
    // A pull that already started would otherwise apply entries under the handover.
    await pullQueue;
    const url = primaryUrl();
    const identity = hostIdentity();
    const head = getLogHead();
    const response = url
      ? await peerFetch(`${url}/api/cluster/handover`, {
          method: 'POST',
          body: {
            clusterId: identity.clusterId,
            hostId: identity.hostId,
            url: selfUrl(),
            after: head.seq,
            afterId: head.id,
          },
        }).catch(() => null)
      : null;
    if (response?.ok) {
      const handover = handoverResponseSchema.parse(await response.json());
      applyLogEntries(handover.entries.filter((entry) => entry.seq > getLogHead().seq));
      becomePrimary(Math.max(getClusterEpoch(), handover.epoch) + 1);
      return { result: 'planned' };
    }
    if (response) {
      const problem = await readPeerError(response);
      // Anything but "not primary any more" means the primary is alive and said no.
      if (problem.code !== 'not_primary')
        throw new Error(problem.error || `Overdracht mislukt (HTTP ${response.status}).`);
    }
    if (!emergency) return { result: 'primary-unreachable' };
    becomePrimary(getClusterEpoch() + 1);
    return { result: 'emergency' };
  } finally {
    busy = null;
  }
}

async function fetchStatus(url: string): Promise<ClusterStatus> {
  const response = await peerFetch(`${url}/api/cluster/status`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as ClusterStatus;
}

function peerFetch(
  url: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {}
): Promise<globalThis.Response> {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'x-apolloon-app-version': APP_VERSION,
      'x-apolloon-schema-version': String(DATABASE_SCHEMA_VERSION),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? requestTimeoutMs),
  });
}

async function readPeerError(response: globalThis.Response): Promise<z.infer<typeof peerErrorSchema>> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = peerErrorSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return { error: text.trim().slice(0, 300) };
}

function selfUrl(): string {
  return configuredSelfUrl || normalizeUrl(hostInfo().url);
}

function normalizeUrl(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
