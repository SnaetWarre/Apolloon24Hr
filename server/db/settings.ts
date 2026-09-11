import { type PublicRecordMode, type AppSettings } from '../../shared/schemas.js';
import { one, run, markAppDataChanged, getDb } from './connection.js';
import { v4 as uuidv4 } from 'uuid';

const VALID_PUBLIC_RECORD_MODES = new Set<PublicRecordMode>(['off', 'day', 'two_hour', 'hour']);

export const DEFAULT_PUBLIC_RECORD_MODE: PublicRecordMode = 'day';

export function getSetting(key: string): string | null {
  const row = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  const result = run('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)', [key, String(value)]);
  if (key === 'public_record_mode' && result.changes > 0) markAppDataChanged();
}

function cleanPublicRecordMode(value: unknown): PublicRecordMode {
  return VALID_PUBLIC_RECORD_MODES.has(value as PublicRecordMode)
    ? (value as PublicRecordMode)
    : DEFAULT_PUBLIC_RECORD_MODE;
}

export function getAppSettings(): AppSettings {
  return {
    publicRecordMode: cleanPublicRecordMode(getSetting('public_record_mode')),
  };
}

export function setPublicRecordMode(mode: PublicRecordMode): AppSettings {
  setSetting('public_record_mode', cleanPublicRecordMode(mode));
  return getAppSettings();
}

export function ensureHostId(): string {
  const existing = getSetting('host_id');
  if (existing) return existing;
  const hostId = uuidv4();
  setSetting('host_id', hostId);
  return hostId;
}

export function setReplicationSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)')
    .run(key, value);
}
