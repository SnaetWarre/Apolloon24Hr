import { type RunnerStatus, type RegistrationSource, type RaceEventType, type Label } from '../../shared/schemas.js';

const VALID_STATUSES = new Set<RunnerStatus>(['registered', 'warming_up', 'waiting', 'running', 'ran']);

const VALID_REGISTRATION_SOURCES = new Set<RegistrationSource>(['import', 'manual']);

const VALID_RACE_EVENT_TYPES = new Set<RaceEventType>(['burgie_gepakt']);

export function cleanText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

export function cleanInt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

export function readPositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function cleanStatus(status: unknown): RunnerStatus {
  return VALID_STATUSES.has(status as RunnerStatus) ? (status as RunnerStatus) : 'registered';
}

export function cleanRegistrationSource(source: unknown): RegistrationSource {
  return VALID_REGISTRATION_SOURCES.has(source as RegistrationSource)
    ? (source as RegistrationSource)
    : 'manual';
}

export function parseLabelsJson(value: unknown): Label[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): Label[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const label = item as Partial<Label>;
      if (
        typeof label.id !== 'string' ||
        typeof label.name !== 'string' ||
        typeof label.color !== 'string' ||
        typeof label.icon !== 'string' ||
        typeof label.kind !== 'string'
      ) {
        return [];
      }
      return [{
        id: label.id,
        name: label.name,
        color: label.color,
        icon: label.icon,
        kind: label.kind,
        imageUrl: typeof label.imageUrl === 'string' ? label.imageUrl : null,
        targetLaps: Number.isSafeInteger(label.targetLaps) ? label.targetLaps! : null,
        sortOrder: Number.isSafeInteger(label.sortOrder) ? label.sortOrder! : null,
        ...(Number.isSafeInteger(label.createdAt) ? { createdAt: label.createdAt } : {}),
        ...(Number.isSafeInteger(label.updatedAt) ? { updatedAt: label.updatedAt } : {}),
      }];
    });
  } catch {
    return [];
  }
}

export function serializeHistoricalLabels(labels: Label[]): string {
  return JSON.stringify(
    labels.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color,
      icon: label.icon,
      kind: label.kind,
      ...(label.imageUrl ? { imageUrl: label.imageUrl } : {}),
    }))
  );
}

export function normalizeName(name: unknown): string {
  return String(name || '').trim().toLowerCase();
}

export function canonicalLabelName(name: unknown): string | null {
  const text = cleanText(name);
  const normalized = normalizeName(text);
  if (['1ste jaars', '1e jaar', '1e jaars', 'eerste jaar', 'eerste jaars'].includes(normalized)) {
    return '1ste jaar';
  }
  return text;
}

export function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function cleanRaceEventType(type: unknown): RaceEventType {
  return VALID_RACE_EVENT_TYPES.has(type as RaceEventType) ? (type as RaceEventType) : 'burgie_gepakt';
}

export function boundedHistoryLimit(value: number): number {
  return Math.max(1, Math.min(1_000, Math.floor(value) || 100));
}
