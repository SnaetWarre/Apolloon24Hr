import { MIN_LAP_MS } from '../../shared/lapTimes';
import { nowMs } from './time';

/** When a timing press happened, independent of how long the request takes. */
export type PressTime = { pressedAt: number; measuredDurationMs?: number };

let previousPress: { pressedAt: number; eventTime: number } | null = null;

/**
 * Times a press from its input event. `eventTime` is the event's timeStamp:
 * a monotonic clock started at page load, set when the key or click arrived.
 * The lap since this screen's previous press is measured on that same clock,
 * so clock corrections can never shorten or stretch it.
 */
export function timePress(eventTime: number, activeStartedAt: number | null): PressTime {
  const monotonicNow = performance.now();
  const eventAt = eventTime > 0 && eventTime <= monotonicNow ? eventTime : monotonicNow;
  const pressedAt = Math.round(nowMs() - (monotonicNow - eventAt));
  const startedTheRunningLap = previousPress !== null && previousPress.pressedAt === activeStartedAt;
  return {
    pressedAt,
    measuredDurationMs: startedTheRunningLap ? Math.round(eventAt - previousPress!.eventTime) : undefined,
  };
}

/** Remembers a press the server accepted as the start of a new lap. */
export function rememberLapStart(press: PressTime, eventTime: number): void {
  previousPress = { pressedAt: press.pressedAt, eventTime: eventTime > 0 ? eventTime : performance.now() };
}

export function forgetLapStart(): void {
  previousPress = null;
}

/** How long the running lap lasted at `press`, if that is too short to be a real lap. */
export function tooShortLapMs(press: PressTime, activeStartedAt: number | null): number | null {
  if (activeStartedAt === null) return null;
  const lapMs = press.measuredDurationMs ?? press.pressedAt - activeStartedAt;
  return lapMs < MIN_LAP_MS ? Math.max(0, lapMs) : null;
}
