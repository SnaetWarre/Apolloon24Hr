/**
 * A screen that already holds revision `since` of the live snapshot or the
 * lap history gets only what changed since then. Fields that did not change
 * are left out. A list field is rebuilt from `[start, end)` ranges of the
 * screen's copy plus the items that are new or changed, so a new lap costs
 * one lap instead of the whole race.
 */
export type ListPatch<T> = Array<[number, number] | T>;

export type Delta<T extends { revision: number }> = {
  since: number;
  revision: number;
  changes: Partial<{ [K in keyof T]: T[K] extends ReadonlyArray<infer Item> ? ListPatch<Item> : T[K] }>;
};

export function isDelta<T extends { revision: number }>(body: T | Delta<T>): body is Delta<T> {
  return 'since' in body && 'changes' in body;
}

export function applyListPatch<T>(base: readonly T[], patch: ListPatch<T>): T[] {
  const result: T[] = [];
  for (const part of patch) {
    if (Array.isArray(part)) {
      const [start, end] = part as [number, number];
      if (!(start >= 0 && end <= base.length)) throw new RangeError('Patch does not fit the list it was made for');
      for (let index = start; index < end; index += 1) result.push(base[index] as T);
    } else result.push(part as T);
  }
  return result;
}

/** Rebuilds the newer revision from `base`; the caller checks `delta.since === base.revision` first. */
export function applyDelta<T extends { revision: number }>(base: T, delta: Delta<T>): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, change] of Object.entries(delta.changes)) {
    const current = result[key];
    result[key] = Array.isArray(current) ? applyListPatch(current, change as ListPatch<unknown>) : change;
  }
  result.revision = delta.revision;
  return result as T;
}
