import React from 'react';
import { nowMs, onServerClockSync } from './time';

const MIN_CLOCK_INTERVAL_MS = 16;
export const LIVE_MILLISECOND_INTERVAL_MS = 1_000 / 30;
export const SECOND_DISPLAY_INTERVAL_MS = 500;
type Clock = {
  cadenceMs: number;
  listeners: Set<(now: number) => void>;
  timeoutId: number | null;
};

const clocks = new Map<number, Clock>();
let visibilityListenerActive = false;

export function normalizeClockInterval(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) return 1_000;
  return Math.max(MIN_CLOCK_INTERVAL_MS, Math.round(intervalMs));
}

/**
 * The server-clock time, refreshed every `intervalMs` while `enabled`.
 * Render from this value, never from a bare nowMs() or Date.now(): the React
 * Compiler caches a call with no inputs, and the clock on screen would stand still.
 * Every component on the same cadence gets the same tick, so clocks never disagree.
 */
export function useClockTick(intervalMs = 100, enabled = true): number {
  const cadenceMs = normalizeClockInterval(intervalMs);
  const [now, setNow] = React.useState(nowMs);
  React.useEffect(() => (enabled ? subscribeToClock(cadenceMs, setNow) : undefined), [cadenceMs, enabled]);
  return now;
}

export function useSecondTick(enabled = true): number {
  return useClockTick(SECOND_DISPLAY_INTERVAL_MS, enabled);
}

function subscribeToClock(cadenceMs: number, listener: (now: number) => void): () => void {
  const clock = clocks.get(cadenceMs) ?? {
    cadenceMs,
    listeners: new Set(),
    timeoutId: null,
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

function notify(clock: Clock): void {
  const now = nowMs();
  for (const listener of clock.listeners) listener(now);
}

/** Ticks fall on the group clock's boundaries, not this laptop's: their clocks differ by seconds. */
export function msUntilNextTick(groupNowMs: number, cadenceMs: number): number {
  return cadenceMs - (groupNowMs % cadenceMs);
}

function scheduleClock(clock: Clock): void {
  if (clock.timeoutId !== null || document.hidden || clock.listeners.size === 0) return;
  clock.timeoutId = window.setTimeout(
    () => {
      clock.timeoutId = null;
      notify(clock);
      scheduleClock(clock);
    },
    msUntilNextTick(nowMs(), clock.cadenceMs)
  );
}

// A sync after a clock was scheduled moves its next boundary, and may already have passed one: tick now and reschedule.
onServerClockSync(() => {
  for (const clock of clocks.values()) {
    notify(clock);
    clearClock(clock);
    scheduleClock(clock);
  }
});

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
    notify(clock);
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
