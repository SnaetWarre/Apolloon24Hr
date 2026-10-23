import { z } from 'zod';
import { DATABASE_SCHEMA_VERSION } from './db.js';
import { APP_VERSION } from './env.js';
import { versionMismatchMessage } from './peers.js';

/*
 * What other laptops send this one, checked before anything reads it. A
 * message that does not fit is logged and dropped, as if it never came, so a
 * broken or foreign sender cannot crash this laptop or change its data.
 * Appends and votes have their own schemas in consensus.ts.
 */

/** A request over the peer socket (peer-socket.ts). */
export const peerSocketRequestSchema = z.object({
  id: z.number().int(),
  type: z.enum(['append', 'vote']),
  body: z.unknown().optional(),
});

/** An answer over the peer socket: a body, or a refusal like an HTTP error. */
export const peerSocketAnswerSchema = z.object({
  id: z.number().int(),
  body: z.unknown().optional(),
  refused: z.object({ code: z.string(), error: z.string() }).optional(),
});

/**
 * A tRPC answer from the leader. A laptop that no longer leads answers with a plain
 * `{ code, error }` instead, so `error` can also be text.
 */
export const trpcAnswerSchema = z.object({
  result: z.object({ data: z.unknown().optional() }).optional(),
  error: z
    .union([
      z.object({ message: z.string().optional(), data: z.object({ code: z.string().optional() }).optional() }),
      z.string(),
    ])
    .optional(),
});

export const peerTimeSchema = z.object({ serverNowMs: z.number().finite() });

export const joinAnswerSchema = z.object({ term: z.number().int().nonnegative() });

const memberSchema = z.object({ hostId: z.string(), url: z.string() });

/** The parts of another laptop's /api/cluster/status this laptop reads. */
export const peerStatusSchema = z.object({
  enabled: z.boolean(),
  hostId: z.string(),
  hostName: z.string().nullable(),
  clusterId: z.string(),
  appVersion: z.string(),
  schemaVersion: z.number(),
  role: z.enum(['leader', 'follower', 'candidate']),
  term: z.number(),
  leader: memberSchema.nullable(),
  members: z.array(memberSchema),
  busy: z.enum(['joining', 'resyncing']).nullable(),
  runners: z.number(),
  // An older version does not send these.
  changed: z.boolean().optional(),
  raceStarted: z.boolean().optional(),
  raceRunning: z.boolean().optional(),
  timing: z.object({ gen: z.number(), reachable: z.boolean() }).nullable(),
  split: z.object({ id: z.string(), rank: z.number() }),
  laps: z.number(),
});

export type PeerStatus = z.infer<typeof peerStatusSchema>;

const peerVersionSchema = z.object({ appVersion: z.string(), schemaVersion: z.number() });

/** Another laptop runs another version, so its status cannot be read; Koppelen shows this message. */
export class PeerVersionError extends Error {}

/**
 * Another laptop's status. A laptop on another version may send another shape;
 * its version is then enough to tell the operator what to do.
 */
export function readPeerStatus(data: unknown, from: string): PeerStatus {
  const version = peerVersionSchema.safeParse(data);
  const status = peerStatusSchema.safeParse(data);
  if (status.success) return status.data;
  if (
    version.success &&
    (version.data.appVersion !== APP_VERSION || version.data.schemaVersion !== DATABASE_SCHEMA_VERSION)
  ) {
    throw new PeerVersionError(versionMismatchMessage(version.data.appVersion));
  }
  warnBadMessage('a status', from, status.error);
  throw new Error(`Onverwacht antwoord van ${from}.`);
}

/** `data` when it fits `schema`; otherwise null, and a line in the log. */
export function readPeerMessage<T>(schema: z.ZodType<T>, data: unknown, what: string, from: string): T | null {
  const parsed = schema.safeParse(data);
  if (parsed.success) return parsed.data;
  warnBadMessage(what, from, parsed.error);
  return null;
}

/** A sender that keeps sending bad messages (a heartbeat comes every 150 ms) is logged once a minute. */
const WARN_EVERY_MS = 60_000;
const lastWarned = new Map<string, number>();

function warnBadMessage(what: string, from: string, error: z.ZodError): void {
  const key = `${what} ${from}`;
  const now = performance.now();
  if (now - (lastWarned.get(key) ?? Number.NEGATIVE_INFINITY) < WARN_EVERY_MS) return;
  lastWarned.set(key, now);
  const issues = error.issues.map((issue) => `${issue.path.join('.') || 'message'}: ${issue.message}`);
  console.warn(`Ignored ${what} from ${from} that does not fit: ${issues.slice(0, 3).join('; ')}`);
}
