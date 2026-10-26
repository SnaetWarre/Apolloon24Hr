import { randomUUID } from 'node:crypto';
import { competitionKey, MAX_COMPETITIONS } from '../../shared/competitions.js';
import {
  appSettingsSchema,
  publicRecordModeSchema,
  type AppSettings,
  type DamagedDatabase,
  type PublicRecordMode,
} from '../../shared/schemas.js';
import { all, one, run, runUncaptured } from './connection.js';

const DEFAULT_PUBLIC_RECORD_MODE: PublicRecordMode = 'day';

/** Settings that are part of the event data: a backup restores them. */
export const EVENT_SETTING_KEYS: readonly string[] = ['public_record_mode', 'competitions_json'];

/**
 * Settings that travel to the other laptops, in the log and in the full copy a new laptop
 * takes: the event data and the group's own bookkeeping. Everything else is host-local.
 */
export const REPLICATED_SETTING_KEYS: readonly string[] = [
  ...EVENT_SETTING_KEYS,
  'cluster_auto_links_json',
  'cluster_unreachable_json',
  'cluster_removed_json',
  'cluster_timing_json',
  'cluster_split_json',
];

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

/** Host-local: the damaged database this laptop put aside when it started, if any. */
export const DAMAGED_DATABASE_SETTING = 'damaged_database_json';

export function damagedDatabase(): DamagedDatabase | null {
  const stored = getSetting(DAMAGED_DATABASE_SETTING);
  return stored ? (JSON.parse(stored) as DamagedDatabase) : null;
}

export function getAppSettings(): AppSettings {
  const stored = publicRecordModeSchema.safeParse(getSetting('public_record_mode'));
  return {
    publicRecordMode: stored.success ? stored.data : DEFAULT_PUBLIC_RECORD_MODE,
    competitions: getCompetitions(),
  };
}

export function setPublicRecordMode(mode: PublicRecordMode): AppSettings {
  setSetting('public_record_mode', mode);
  return getAppSettings();
}

/**
 * The competitions on the Competitiescherm, shared by every laptop in the group.
 * A deleted label drops out, and so does a competition left with one team.
 */
function getCompetitions(): string[][] {
  let stored: unknown = [];
  try {
    stored = JSON.parse(getSetting('competitions_json') || '[]');
  } catch {
    // A damaged value leaves the screen empty instead of breaking every screen.
  }
  const parsed = appSettingsSchema.shape.competitions.safeParse(stored);
  if (!parsed.success) return [];
  const keys = new Set<string>();
  const competitions: string[][] = [];
  const existing = existingTeams();
  for (const competition of parsed.data) {
    const teams = existing(competition);
    const key = competitionKey(teams);
    if (teams.length < 2 || keys.has(key)) continue;
    keys.add(key);
    competitions.push(teams);
  }
  return competitions.slice(0, MAX_COMPETITIONS);
}

/** Leaves out labels that were deleted, and a label picked twice. */
function existingTeams() {
  const labelIds = new Set(all<{ id: string }>('SELECT id FROM labels').map((label) => label.id));
  return (competition: string[]) => [...new Set(competition)].filter((id) => labelIds.has(id));
}

function setCompetitions(competitions: string[][]): AppSettings {
  setSetting('competitions_json', JSON.stringify(competitions));
  return getAppSettings();
}

export function addCompetition(labelIds: string[]): AppSettings {
  const competitions = getCompetitions();
  const teams = existingTeams()(labelIds);
  if (teams.length < 2) throw new Error('Een competitie heeft minstens twee bestaande ploegen nodig.');
  const key = competitionKey(teams);
  if (competitions.some((competition) => competitionKey(competition) === key)) return getAppSettings();
  if (competitions.length >= MAX_COMPETITIONS) {
    throw new Error(`Er passen ${MAX_COMPETITIONS} competities op het Competitiescherm.`);
  }
  return setCompetitions([...competitions, teams]);
}

export function removeCompetition(labelIds: string[]): AppSettings {
  // A screen that has not seen a label deletion yet still sends the deleted id.
  const key = competitionKey(existingTeams()(labelIds));
  return setCompetitions(getCompetitions().filter((competition) => competitionKey(competition) !== key));
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
    clusterId: ensureLocalSetting('replication_cluster_id', () => randomUUID()),
  };
}
