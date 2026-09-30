import React from 'react';

// How long an item counts as "just arrived". Longer than its entrance animation,
// so a screen that re-renders every clock tick never cuts the animation short.
const ARRIVAL_WINDOW_MS = 1_200;

export type ArrivalState = { seeded: boolean; firstSeenAt: Map<string, number> };

export function createArrivalState(): ArrivalState {
  return { seeded: false, firstSeenAt: new Map() };
}

/**
 * Which ids appeared after the list was first shown. The first render with
 * data seeds the list silently, so a page never animates everything at once.
 * Ids that disappear are forgotten, so a runner that leaves and returns arrives again.
 */
export function trackArrivals(state: ArrivalState, ids: readonly string[], ready: boolean, now: number): Set<string> {
  const arrived = new Set<string>();
  if (!ready) return arrived;
  const present = new Set(ids);
  for (const id of state.firstSeenAt.keys()) if (!present.has(id)) state.firstSeenAt.delete(id);
  for (const id of ids) {
    if (!state.seeded) state.firstSeenAt.set(id, Number.NEGATIVE_INFINITY);
    else if (!state.firstSeenAt.has(id)) state.firstSeenAt.set(id, now);
    if (now - (state.firstSeenAt.get(id) ?? now) < ARRIVAL_WINDOW_MS) arrived.add(id);
  }
  state.seeded = true;
  return arrived;
}

/** Ids in `ids` that arrived after the first render with data; give those an entrance animation. */
export function useArrivals(ids: readonly string[], ready = true): ReadonlySet<string> {
  // One bookkeeping object per component; it is updated in place, never replaced.
  const [state] = React.useState(createArrivalState);
  return trackArrivals(state, ids, ready, Date.now());
}

/** A flag that is true for `durationMs` after `trigger()`, for one-shot feedback such as a press. */
export function usePulse(durationMs: number): [boolean, () => void] {
  const [active, setActive] = React.useState(false);
  const timeoutRef = React.useRef<number | null>(null);
  const trigger = () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    setActive(true);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setActive(false);
    }, durationMs);
  };
  React.useEffect(
    () => () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    },
    []
  );
  return [active, trigger];
}
