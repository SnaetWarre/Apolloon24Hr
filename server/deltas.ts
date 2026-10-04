import type { Delta, ListPatch } from '../shared/delta.js';

/** Revisions kept to answer from; a screen further behind gets everything again. */
const KEPT_REVISIONS = 8;

type Version = {
  fields: Map<string, string>;
  lists: Map<string, { items: string[]; positions: Map<string, number> }>;
};

/**
 * Remembers the last few revisions of one response, to answer a screen that
 * holds one of them with only what changed. Items are compared by their JSON,
 * so a lap whose runner was renamed counts as changed, and the screen ends up
 * with exactly what a full response would have held.
 */
export function createDeltaStore<T extends { revision: number }>({
  alwaysSend = [],
}: { alwaysSend?: Array<keyof T & string> } = {}) {
  const versions = new Map<number, Version>();

  function remember(value: T): Version {
    const version = describe(value);
    if (!versions.has(value.revision)) {
      versions.set(value.revision, version);
      if (versions.size > KEPT_REVISIONS) versions.delete(versions.keys().next().value as number);
    }
    return version;
  }

  function describe(value: T): Version {
    const version: Version = { fields: new Map(), lists: new Map() };
    for (const [key, field] of Object.entries(value)) {
      if (Array.isArray(field)) {
        const items = field.map((item) => JSON.stringify(item));
        const positions = new Map<string, number>();
        items.forEach((item, index) => {
          if (!positions.has(item)) positions.set(item, index);
        });
        version.lists.set(key, { items, positions });
      } else version.fields.set(key, JSON.stringify(field));
    }
    return version;
  }

  /** The changes from revision `since` to `value` (which is remembered), or null when that revision is gone or nothing would be saved. */
  function diff(since: number, value: T): Delta<T> | null {
    const current = remember(value);
    const base = versions.get(since);
    if (!base || since > value.revision) return null;
    const changes: Record<string, unknown> = {};
    let size = 0;
    let fullSize = 0;
    for (const [key, json] of current.fields) {
      if (key === 'revision') continue;
      fullSize += json.length;
      if (json !== base.fields.get(key) || alwaysSend.includes(key as keyof T & string)) {
        changes[key] = value[key as keyof T];
        size += json.length;
      }
    }
    for (const [key, list] of current.lists) {
      const before = base.lists.get(key);
      if (!before) return null;
      const values = value[key as keyof T] as unknown[];
      const patch: ListPatch<unknown> = [];
      let range: [number, number] | null = null;
      let unchanged = list.items.length === before.items.length;
      list.items.forEach((item, index) => {
        fullSize += item.length;
        const at = before.positions.get(item);
        if (at !== index) unchanged = false;
        if (at === undefined) {
          range = null;
          patch.push(values[index]);
          size += item.length;
        } else if (range && range[1] === at) range[1] += 1;
        else {
          range = [at, at + 1];
          patch.push(range);
          size += 16;
        }
      });
      if (!unchanged) changes[key] = patch;
    }
    // Mostly new (a restore, an import): the whole response is no larger.
    if (size >= fullSize) return null;
    return { since, revision: value.revision, changes: changes as Delta<T>['changes'] };
  }

  return { remember, diff };
}
