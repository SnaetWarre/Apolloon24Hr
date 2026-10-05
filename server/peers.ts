import { z } from 'zod';
import { DATABASE_SCHEMA_VERSION } from './db.js';
import { APP_VERSION, readPositiveInt } from './env.js';
import { hostInfo } from './host.js';

const configuredSelfUrl = normalizeUrl(process.env.CLUSTER_SELF_URL);
/** How long another laptop may take to answer, connecting included. */
export const PEER_REQUEST_TIMEOUT_MS = readPositiveInt(process.env.CLUSTER_REQUEST_TIMEOUT_MS, 1_000);

/** Tests cut a laptop off from the others to simulate a broken cable. */
let isolated = false;

export function setIsolated(next: boolean): void {
  isolated = next;
}

export function isIsolated(): boolean {
  return isolated;
}

/** A request to another laptop, carrying this laptop's version so mismatches are refused early. */
export function peerFetch(
  url: string,
  init: {
    method?: 'GET' | 'POST';
    body?: unknown;
    timeoutMs?: number;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {}
): Promise<globalThis.Response> {
  if (isolated) return Promise.reject(new Error('isolated for a test'));
  const timeout = AbortSignal.timeout(init.timeoutMs ?? PEER_REQUEST_TIMEOUT_MS);
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...versionHeaders(), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
  });
}

/** Sent with every request and peer socket, so laptops on another version are refused early. */
export function versionHeaders(): Record<string, string> {
  return { 'x-apolloon-app-version': APP_VERSION, 'x-apolloon-schema-version': String(DATABASE_SCHEMA_VERSION) };
}

/** Why a laptop sending these version headers is refused, or null when it runs this version. */
export function versionRefusal(appVersion: string | undefined, schemaVersion: string | undefined): string | null {
  if (appVersion === APP_VERSION && Number(schemaVersion) === DATABASE_SCHEMA_VERSION) return null;
  return versionMismatchMessage(appVersion || 'onbekend');
}

const peerErrorSchema = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
});

export async function readPeerError(response: globalThis.Response): Promise<z.infer<typeof peerErrorSchema>> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = peerErrorSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return { error: text.trim().slice(0, 300) };
}

export function versionMismatchMessage(otherVersion: string): string {
  return `Upgrade vereist: deze laptop draait Apolloon ${APP_VERSION}, de andere ${otherVersion}. Installeer overal dezelfde versie.`;
}

/** The address other laptops use to reach this one. */
export function selfUrl(): string {
  return configuredSelfUrl || normalizeUrl(hostInfo().url);
}

export function normalizeUrl(value: unknown): string {
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
