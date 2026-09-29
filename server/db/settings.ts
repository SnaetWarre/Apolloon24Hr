import { randomUUID } from 'node:crypto';
import { publicRecordModeSchema, type AppSettings, type PublicRecordMode } from '../../shared/schemas.js';
import { one, run, runUncaptured } from './connection.js';

const DEFAULT_PUBLIC_RECORD_MODE: PublicRecordMode = 'day';

/** Settings that are part of the event data and travel to the other laptops. Everything else is host-local. */
export const REPLICATED_SETTING_KEYS: readonly string[] = ['public_record_mode'];

export function getSetting(key: string): string | null {
  return one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
}

/** Replicated setting: captured into the active write like any application change. */
function setSetting(key: string, value: string): void {
  run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, value]);
}

/** Host-local setting (identity, cluster role, schema version): never replicated. */
export function setLocalSetting(key: string, value: string): void {
  runUncaptured('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, value]);
}

export function getAppSettings(): AppSettings {
  const stored = publicRecordModeSchema.safeParse(getSetting('public_record_mode'));
  return { publicRecordMode: stored.success ? stored.data : DEFAULT_PUBLIC_RECORD_MODE };
}

export function setPublicRecordMode(mode: PublicRecordMode): AppSettings {
  setSetting('public_record_mode', mode);
  return getAppSettings();
}

/** Returns the host-local setting, creating and storing it on first use. */
function ensureLocalSetting(key: string, create: () => string): string {
  const existing = getSetting(key);
  if (existing) return existing;
  const value = create();
  setLocalSetting(key, value);
  return value;
}

export type HostIdentity = { hostId: string; clusterId: string };

/** This laptop's id, and the id of the group it belongs to (adopted when joining). */
export function hostIdentity(): HostIdentity {
  return {
    hostId: ensureLocalSetting('host_id', randomUUID),
    clusterId: ensureLocalSetting('replication_cluster_id', () => process.env.CLUSTER_ID?.trim() || randomUUID()),
  };
}
