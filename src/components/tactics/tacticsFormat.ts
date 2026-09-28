import { formatDurationMs } from '../../lib/time';
import { RACE_DURATION_HOURS, parseHistoricalRace, type HistoricalRace } from '../../lib/tactics';

export const HISTORICAL_RACE_STORAGE_KEY = 'apolloon.kobe-tactics.historical-race.v1';
export const HISTORICAL_RACE_NAME_STORAGE_KEY = 'apolloon.kobe-tactics.historical-race-name.v1';
export const TACTICS_SCENARIO_STORAGE_KEY = 'apolloon.kobe-tactics.scenario.v1';
export const BUNDLED_REFERENCE_URL = '/reference/quivr-2025-lap-times.json';
export const BUNDLED_REFERENCE_NAME = 'Quivr 2025';
export const APOLLOON_TEAM_ID = 1;
export const VTK_TEAM_ID = 4;
export const DEFAULT_TARGET_LAPS = 800;

export type TargetProfile = 'flat' | 'apolloon' | 'vtk';
export type StoredTacticsScenario = {
  targetLaps: number;
  targetProfile: TargetProfile;
  targetPaces: number[];
};

export function loadStoredHistoricalRace(): HistoricalRace | null {
  const storedJson = localStorage.getItem(HISTORICAL_RACE_STORAGE_KEY);
  if (!storedJson) return null;
  try {
    return parseHistoricalRace(storedJson);
  } catch {
    localStorage.removeItem(HISTORICAL_RACE_STORAGE_KEY);
    localStorage.removeItem(HISTORICAL_RACE_NAME_STORAGE_KEY);
    return null;
  }
}

export function loadStoredTacticsScenario(): StoredTacticsScenario | null {
  const storedJson = localStorage.getItem(TACTICS_SCENARIO_STORAGE_KEY);
  if (!storedJson) return null;
  try {
    const storedScenario = JSON.parse(storedJson) as Partial<StoredTacticsScenario>;
    if (
      typeof storedScenario.targetLaps !== 'number'
      || !Number.isFinite(storedScenario.targetLaps)
      || storedScenario.targetLaps < 1
      || !['flat', 'apolloon', 'vtk'].includes(storedScenario.targetProfile ?? '')
      || !Array.isArray(storedScenario.targetPaces)
      || storedScenario.targetPaces.length !== RACE_DURATION_HOURS
      || storedScenario.targetPaces.some((pace) => typeof pace !== 'number' || !Number.isFinite(pace) || pace <= 0)
    ) {
      throw new Error('Ongeldig opgeslagen scenario.');
    }
    return storedScenario as StoredTacticsScenario;
  } catch {
    localStorage.removeItem(TACTICS_SCENARIO_STORAGE_KEY);
    return null;
  }
}

export function formatPaceSeconds(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return 'Geen data';
  return formatDurationMs(seconds * 1_000);
}

/** Signed time gap for axes and tooltips: "+45 s", "-2:05", "+1:02:30". */
export function formatSignedGap(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const sign = seconds > 0 ? '+' : seconds < 0 ? '-' : '';
  const total = Math.round(Math.abs(seconds));
  if (total < 60) return `${sign}${total} s`;
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours
    ? `${sign}${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${sign}${minutes}:${rest}`;
}

export function formatRaceHour(hours: number): string {
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${wholeHours}u${String(minutes).padStart(2, '0')}` : `${wholeHours}u`;
}

export function formatRaceHourWindow(raceStartedAt: number, raceHour: number): string {
  const formatter = new Intl.DateTimeFormat('nl-BE', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Brussels',
  });
  const startedAt = raceStartedAt + raceHour * 3_600_000;
  return `${formatter.format(startedAt)}-${formatter.format(startedAt + 3_600_000)}`;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
