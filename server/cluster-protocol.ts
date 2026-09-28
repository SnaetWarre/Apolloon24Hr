import crypto from 'node:crypto';
import { clusterCompatibilitySchema, type ClusterCompatibility } from '../shared/schemas.js';
import { CLUSTER_PROTOCOL_VERSION } from './cluster-compatibility.js';

export type OperationVector = Record<string, number>;

export type DiscoveryPayload = {
  app: 'apolloon';
  protocol: number;
  compatibility: ClusterCompatibility;
  clusterId: string;
  hostId: string;
  url: string;
  vector: OperationVector;
  sentAt: number;
  signature: string;
};

type UnsignedDiscoveryPayload = Omit<DiscoveryPayload, 'signature'>;

const MAX_VECTOR_HOSTS = 64;

export function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** Validates a vector received from the network; null when anything is off. */
export function normalizeOperationVector(value: unknown): OperationVector | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_VECTOR_HOSTS) return null;
  const valid = entries.every(
    ([hostId, sequence]) => isValidId(hostId) && Number.isSafeInteger(sequence) && (sequence as number) >= 0
  );
  return valid ? (Object.fromEntries(entries) as OperationVector) : null;
}

export function signDiscoveryPayload(payload: UnsignedDiscoveryPayload, clusterSecret: string): DiscoveryPayload {
  return { ...payload, signature: discoverySignature(payload, clusterSecret) };
}

/** Returns the payload only when it is well-formed and signed with this cluster's secret. */
export function verifyDiscoveryPayload(value: unknown, clusterSecret: string): DiscoveryPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<DiscoveryPayload>;
  const vector = normalizeOperationVector(payload.vector);
  if (
    payload.app !== 'apolloon' ||
    payload.protocol !== CLUSTER_PROTOCOL_VERSION ||
    !clusterCompatibilitySchema.safeParse(payload.compatibility).success ||
    !isValidId(payload.clusterId) ||
    !isValidId(payload.hostId) ||
    typeof payload.url !== 'string' ||
    !payload.url ||
    payload.url.length > 2_048 ||
    !Number.isSafeInteger(payload.sentAt) ||
    !vector ||
    typeof payload.signature !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(payload.signature)
  ) {
    return null;
  }

  const unsigned: UnsignedDiscoveryPayload = {
    app: 'apolloon',
    protocol: CLUSTER_PROTOCOL_VERSION,
    compatibility: payload.compatibility as ClusterCompatibility,
    clusterId: payload.clusterId,
    hostId: payload.hostId,
    url: payload.url,
    vector,
    sentAt: payload.sentAt as number,
  };
  if (!secureEqual(payload.signature, discoverySignature(unsigned, clusterSecret))) return null;
  return { ...unsigned, signature: payload.signature };
}

export function secureEqual(received: unknown, expected: string): boolean {
  if (typeof received !== 'string') return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function discoverySignature(payload: UnsignedDiscoveryPayload, clusterSecret: string): string {
  const canonicalVector = Object.fromEntries(Object.entries(payload.vector).sort(([a], [b]) => a.localeCompare(b)));
  return crypto
    .createHmac('sha256', clusterSecret)
    .update(
      JSON.stringify({
        app: payload.app,
        protocol: payload.protocol,
        compatibility: payload.compatibility,
        clusterId: payload.clusterId,
        hostId: payload.hostId,
        url: payload.url,
        vector: canonicalVector,
        sentAt: payload.sentAt,
      })
    )
    .digest('hex');
}
