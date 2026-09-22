import {
  clusterCompatibilitySchema,
  type ClusterCompatibility,
} from '../shared/schemas.js';

export const CLUSTER_PROTOCOL_VERSION = 3;
export const REPLICATION_FORMAT_VERSION = 1;

const DEFAULT_APP_VERSION = '3.0.0';

export function localClusterCompatibility(schemaVersion: number): ClusterCompatibility {
  const appVersion = cleanVersion(process.env.APOLLOON_APP_VERSION) || DEFAULT_APP_VERSION;
  return {
    protocolVersion: CLUSTER_PROTOCOL_VERSION,
    schemaVersion,
    minimumSchemaVersion: readPositiveInt(
      process.env.APOLLOON_MIN_COMPATIBLE_SCHEMA_VERSION,
      schemaVersion
    ),
    replicationFormatVersion: REPLICATION_FORMAT_VERSION,
    minimumReplicationFormatVersion: readPositiveInt(
      process.env.APOLLOON_MIN_COMPATIBLE_REPLICATION_FORMAT_VERSION,
      REPLICATION_FORMAT_VERSION
    ),
    appVersion,
    minimumAppVersion:
      cleanVersion(process.env.APOLLOON_MIN_COMPATIBLE_APP_VERSION) || appVersion,
    releaseId: process.env.APOLLOON_RELEASE_ID?.trim() || null,
  };
}

export function parseClusterCompatibility(value: unknown): ClusterCompatibility | null {
  const parsed = clusterCompatibilitySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function clusterCompatibilityError(
  remote: ClusterCompatibility | null,
  local: ClusterCompatibility
): string | null {
  if (!remote) {
    return 'Upgrade vereist: de andere laptop verstuurt geen compatibiliteitsinformatie.';
  }
  if (
    remote.minimumSchemaVersion > remote.schemaVersion ||
    remote.minimumReplicationFormatVersion > remote.replicationFormatVersion
  ) {
    return versionError(remote, 'de andere laptop verstuurt ongeldige compatibiliteitsgrenzen');
  }
  if (remote.protocolVersion !== local.protocolVersion) {
    return versionError(
      remote,
      `clusterprotocol ${remote.protocolVersion} past niet bij ${local.protocolVersion}`
    );
  }
  if (
    remote.schemaVersion < local.minimumSchemaVersion ||
    local.schemaVersion < remote.minimumSchemaVersion
  ) {
    return versionError(
      remote,
      `databaseschema ${remote.schemaVersion} past niet bij ${local.schemaVersion}`
    );
  }
  if (
    remote.replicationFormatVersion < local.minimumReplicationFormatVersion ||
    local.replicationFormatVersion < remote.minimumReplicationFormatVersion
  ) {
    return versionError(
      remote,
      `replicatieformaat ${remote.replicationFormatVersion} past niet bij ${local.replicationFormatVersion}`
    );
  }
  const remoteVersion = parseVersion(remote.appVersion);
  const localVersion = parseVersion(local.appVersion);
  const remoteMinimum = parseVersion(remote.minimumAppVersion);
  const localMinimum = parseVersion(local.minimumAppVersion);
  if (
    !remoteVersion ||
    !localVersion ||
    !remoteMinimum ||
    !localMinimum ||
    compareVersions(remoteVersion, remoteMinimum) < 0 ||
    compareVersions(localVersion, localMinimum) < 0 ||
    compareVersions(remoteVersion, localMinimum) < 0 ||
    compareVersions(localVersion, remoteMinimum) < 0
  ) {
    return versionError(
      remote,
      `appversie ${remote.appVersion} past niet bij ${local.appVersion}`
    );
  }
  return null;
}

function versionError(remote: ClusterCompatibility, detail: string): string {
  const remoteRelease = remote.releaseId ? ` (${remote.releaseId.slice(0, 12)})` : '';
  return `Upgrade vereist: ${detail}. Werk beide laptops bij voor je synchroniseert${remoteRelease}.`;
}

function cleanVersion(value: unknown): string {
  return typeof value === 'string' && parseVersion(value.trim()) ? value.trim() : '';
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number) as [number, number, number];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(
  left: [number, number, number],
  right: [number, number, number]
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
