import { type Label } from '../../shared/schemas.js';

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
    return [
      {
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
      },
    ];
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

const FIRST_YEAR_ALIASES = new Set(['1ste jaars', '1e jaar', '1e jaars', 'eerste jaar', 'eerste jaars']);

/** Folds the ways people spell the first-year label into one; empty names give null. */
export function canonicalLabelName(name: string): string | null {
  const text = name.trim();
  if (!text) return null;
  return FIRST_YEAR_ALIASES.has(text.toLowerCase()) ? '1ste jaar' : text;
}

export function boundedHistoryLimit(value: number): number {
  return Math.max(1, Math.min(1_000, Math.floor(value) || 100));
}
