import {
  raceEventTypeSchema,
  registrationSourceSchema,
  runnerStatusSchema,
  type Label,
  type RaceEventType,
  type RegistrationSource,
  type RunnerStatus,
} from '../../shared/schemas.js';

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

export function cleanStatus(status: unknown): RunnerStatus {
  const parsed = runnerStatusSchema.safeParse(status);
  return parsed.success ? parsed.data : 'registered';
}

export function cleanRegistrationSource(source: unknown): RegistrationSource {
  const parsed = registrationSourceSchema.safeParse(source);
  return parsed.success ? parsed.data : 'manual';
}

export function cleanRaceEventType(type: unknown): RaceEventType {
  const parsed = raceEventTypeSchema.safeParse(type);
  return parsed.success ? parsed.data : 'burgie_gepakt';
}

/** Reads label snapshots stored on laps and the race state; older rows omit optional fields. */
export function parseLabelsJson(value: unknown): Label[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
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
}

/** Compact label snapshot stored with each lap, so later label edits never rewrite history. */
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

const FIRST_YEAR_ALIASES = new Set(['1ste jaars', '1e jaar', '1e jaars', 'eerste jaar', 'eerste jaars']);

export function canonicalLabelName(name: unknown): string | null {
  const text = cleanText(name);
  return FIRST_YEAR_ALIASES.has(normalizeName(text)) ? '1ste jaar' : text;
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

export function boundedHistoryLimit(value: number): number {
  return Math.max(1, Math.min(1_000, Math.floor(value) || 100));
}
