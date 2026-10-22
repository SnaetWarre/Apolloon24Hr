import { MIN_LAP_MS } from './lapTimes.js';

/**
 * The prize system of the 2026 race ("Prijzensysteem 2026.xlsx"), shared by the Binnenscherm
 * ranking and the Excel export. Change the numbers here for a new edition.
 */
export const POINTS_RULES = {
  basePointsPerLap: 20,
  referenceLapSeconds: 85,
  /** Extra time coefficient per second a lap is faster than the reference. */
  coefficientPerSecond: 0.125,
  /** By the Brussels clock hour a lap started; each part runs until the next one starts. */
  dayparts: [
    { name: '00-04u', fromHour: 0, toHour: 4, factor: 1.3 },
    { name: '04-08u', fromHour: 4, toHour: 8, factor: 1.8 },
    { name: '08-12u', fromHour: 8, toHour: 12, factor: 1.8 },
    { name: '12-16u', fromHour: 12, toHour: 16, factor: 1.3 },
    { name: '16-20u', fromHour: 16, toHour: 20, factor: 1 },
    { name: '20-24u', fromHour: 20, toHour: 24, factor: 1 },
  ],
} as const;

export type Daypart = (typeof POINTS_RULES.dayparts)[number];

type ScoredLap = { durationMs: number; startedAt: number; source: string };

const BRUSSELS_HOUR_FORMATTER = new Intl.DateTimeFormat('nl-BE', {
  hour: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Brussels',
});

// A lap under MIN_LAP_MS is a double press, and the second half of a split lap is a guess,
// so neither flashes, is a record to beat, nor earns a speed bonus.
export function isMeasuredLap(lap: Pick<ScoredLap, 'durationMs' | 'source'>): boolean {
  return lap.durationMs >= MIN_LAP_MS && lap.source !== 'split';
}

export function lapTimeCoefficient(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs < 0) return 0;
  const secondsFaster = Math.max(0, POINTS_RULES.referenceLapSeconds - durationMs / 1_000);
  return 1 + secondsFaster * POINTS_RULES.coefficientPerSecond;
}

/** The daypart of the Brussels clock hour a lap started in; null for a lap without a valid start. */
export function lapDaypart(startedAt: number): Daypart | null {
  if (!Number.isFinite(startedAt)) return null;
  const hour = Number(BRUSSELS_HOUR_FORMATTER.format(startedAt));
  return POINTS_RULES.dayparts.find((daypart) => hour >= daypart.fromHour && hour < daypart.toHour) ?? null;
}

/** Points per lap = base points × time coefficient × daypart factor. */
export function lapPoints(lap: ScoredLap): number {
  const daypart = lapDaypart(lap.startedAt);
  if (!daypart) return 0;
  const coefficient = isMeasuredLap(lap) ? lapTimeCoefficient(lap.durationMs) : 1;
  return POINTS_RULES.basePointsPerLap * coefficient * daypart.factor;
}
