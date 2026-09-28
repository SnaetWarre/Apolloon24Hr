import { v4 as uuidv4 } from 'uuid';
import { publicRecordModeSchema, type PublicRecordMode, type AppSettings } from '../../shared/schemas.js';
import { one, run, runUncaptured, markAppDataChanged } from './connection.js';

export const DEFAULT_PUBLIC_RECORD_MODE: PublicRecordMode = 'day';

export function getSetting(key: string): string | null {
  return one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
}

/** Replicated setting: captured into the active command like any application write. */
export function setSetting(key: string, value: string): void {
  run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, value]);
}

/** Host-local setting (identity, clocks, checkpoints): never replicated. */
export function setLocalSetting(key: string, value: string): void {
  runUncaptured('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, value]);
}

export function deleteLocalSetting(key: string): void {
  runUncaptured('DELETE FROM settings WHERE key = ?', [key]);
}

export function getAppSettings(): AppSettings {
  const stored = publicRecordModeSchema.safeParse(getSetting('public_record_mode'));
  return { publicRecordMode: stored.success ? stored.data : DEFAULT_PUBLIC_RECORD_MODE };
}

export function setPublicRecordMode(mode: PublicRecordMode): AppSettings {
  const parsed = publicRecordModeSchema.safeParse(mode);
  setSetting('public_record_mode', parsed.success ? parsed.data : DEFAULT_PUBLIC_RECORD_MODE);
  markAppDataChanged();
  return getAppSettings();
}

/** Returns the host-local setting, creating and storing it on first use. */
export function ensureLocalSetting(key: string, create: () => string): string {
  const existing = getSetting(key);
  if (existing) return existing;
  const value = create();
  setLocalSetting(key, value);
  return value;
}

export function ensureHostId(): string {
  return ensureLocalSetting('host_id', uuidv4);
}
