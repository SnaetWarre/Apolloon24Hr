import crypto from 'node:crypto';
import {
  clusterCompatibilitySchema,
  type ClusterCompatibility,
} from '../shared/schemas.js';
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

export function normalizeOperationVector(value: unknown): OperationVector | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_VECTOR_HOSTS) return null;

  const normalizedEntries: Array<[string, number]> = [];
  for (const [hostId, sequence] of entries) {
    if (
      !hostId ||
      hostId.length > 128 ||
      !Number.isSafeInteger(sequence) ||
      (sequence as number) < 0
    ) {
      return null;
    }
    normalizedEntries.push([hostId, sequence as number]);
  }
  return Object.fromEntries(normalizedEntries);
}

export function signDiscoveryPayload(
  payload: UnsignedDiscoveryPayload,
  clusterSecret: string
): DiscoveryPayload {
  return {
    ...payload,
    signature: discoverySignature(payload, clusterSecret),
  };
}

export function verifyDiscoveryPayload(
  value: unknown,
  clusterSecret: string
): DiscoveryPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Partial<DiscoveryPayload>;
  const vector = normalizeOperationVector(payload.vector);
  if (
    payload.app !== 'apolloon' ||
    payload.protocol !== CLUSTER_PROTOCOL_VERSION ||
    !clusterCompatibilitySchema.safeParse(payload.compatibility).success ||
    typeof payload.clusterId !== 'string' ||
    !payload.clusterId ||
    payload.clusterId.length > 128 ||
    typeof payload.hostId !== 'string' ||
    !payload.hostId ||
    payload.hostId.length > 128 ||
    typeof payload.url !== 'string' ||
    !payload.url ||
    payload.url.length > 2_048 ||
    typeof payload.sentAt !== 'number' ||
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
    sentAt: payload.sentAt,
  };
  const expected = discoverySignature(unsigned, clusterSecret);
  if (!secureEqual(payload.signature, expected)) return null;
  return { ...unsigned, signature: payload.signature };
}

export function secureEqual(received: unknown, expected: string): boolean {
  if (typeof received !== 'string') return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

function discoverySignature(
  payload: UnsignedDiscoveryPayload,
  clusterSecret: string
): string {
  const canonicalVector = Object.fromEntries(
    Object.entries(payload.vector).sort(([a], [b]) => a.localeCompare(b))
  );
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
