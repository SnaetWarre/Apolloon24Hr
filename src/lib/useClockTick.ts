import React from 'react';

const MIN_CLOCK_INTERVAL_MS = 16;
export const LIVE_MILLISECOND_INTERVAL_MS = 1_000 / 30;
export const SECOND_DISPLAY_INTERVAL_MS = 500;
type Clock = {
  cadenceMs: number;
  listeners: Set<() => void>;
  timeoutId: number | null;
  version: number;
};

const clocks = new Map<number, Clock>();
let visibilityListenerActive = false;

export function normalizeClockInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return 1_000;
  return Math.max(MIN_CLOCK_INTERVAL_MS, Math.round(intervalMs));
}

export function useClockTick(intervalMs = 100, enabled = true): void {
  const cadenceMs = normalizeClockInterval(intervalMs);
  const subscribe = React.useCallback(
    (listener: () => void) => (enabled ? subscribeToClock(cadenceMs, listener) : () => undefined),
    [cadenceMs, enabled]
  );
  const getSnapshot = React.useCallback(
    () => (enabled ? (clocks.get(cadenceMs)?.version ?? 0) : 0),
    [cadenceMs, enabled]
  );
  React.useSyncExternalStore(subscribe, getSnapshot, () => 0);
}

export function useSecondTick(enabled = true): void {
  useClockTick(SECOND_DISPLAY_INTERVAL_MS, enabled);
}

function subscribeToClock(cadenceMs: number, listener: () => void): () => void {
  const clock = clocks.get(cadenceMs) ?? {
    cadenceMs,
    listeners: new Set(),
    timeoutId: null,
    version: 0,
  };
  clock.listeners.add(listener);
  clocks.set(cadenceMs, clock);
  ensureVisibilityListener();
  scheduleClock(clock);

  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size > 0) return;
    clearClock(clock);
    clocks.delete(cadenceMs);
    removeVisibilityListenerIfIdle();
  };
}

function scheduleClock(clock: Clock): void {
  if (clock.timeoutId !== null || document.hidden || clock.listeners.size === 0) return;
  const untilNextCadence = clock.cadenceMs - (Date.now() % clock.cadenceMs);
  clock.timeoutId = window.setTimeout(() => {
    clock.timeoutId = null;
    clock.version = (clock.version + 1) % 1_000_000;
    for (const listener of clock.listeners) listener();
    scheduleClock(clock);
  }, untilNextCadence);
}

function clearClock(clock: Clock): void {
  if (clock.timeoutId === null) return;
  window.clearTimeout(clock.timeoutId);
  clock.timeoutId = null;
}

function handleVisibilityChange(): void {
  for (const clock of clocks.values()) {
    if (document.hidden) {
      clearClock(clock);
      continue;
    }
    clock.version = (clock.version + 1) % 1_000_000;
    for (const listener of clock.listeners) listener();
    scheduleClock(clock);
  }
}

function ensureVisibilityListener(): void {
  if (visibilityListenerActive) return;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  visibilityListenerActive = true;
}

function removeVisibilityListenerIfIdle(): void {
  if (!visibilityListenerActive || clocks.size > 0) return;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  visibilityListenerActive = false;
}
