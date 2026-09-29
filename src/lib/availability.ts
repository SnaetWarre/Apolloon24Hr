import type { Runner, RunnerRegistration } from '../types';

/**
 * The registration form asks "Ik ben volgende uren beschikbaar" and stores the
 * chosen blocks as text such as `20-21u (dinsdag)` or `23-00u (dinsdag)`.
 * This module turns those into a list of runners who could run right now but
 * are not warming up or waiting, so the crew knows who to call.
 */

export type HourBlock = {
  startHour: number;
  endHour: number;
  /** Lowercase Dutch weekday from the form, or null when the block has none. */
  weekday: string | null;
};

/** Wall clock in Brussels: the hour and the Dutch weekday name, as the form uses them. */
export type ClockMoment = {
  hour: number;
  weekday: string;
};

export type AvailableRunner = {
  runner: Runner;
  phone: string;
  flexibility: string;
};

const HOUR_BLOCK_PATTERN = /^\s*(\d{1,2})\s*u?\s*[-–]\s*(\d{1,2})\s*u?\s*(?:\(\s*([^)]*?)\s*\))?\s*$/i;

const BRUSSELS_MOMENT_FORMATTER = new Intl.DateTimeFormat('nl-BE', {
  hour: '2-digit',
  hourCycle: 'h23',
  weekday: 'long',
  timeZone: 'Europe/Brussels',
});

export function parseHourBlock(text: string): HourBlock | null {
  const match = HOUR_BLOCK_PATTERN.exec(text);
  if (!match) return null;
  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  if (startHour > 23 || endHour > 24 || startHour === endHour) return null;
  const weekday = match[3]?.trim().toLowerCase() || null;
  return { startHour, endHour: endHour === 24 ? 0 : endHour, weekday };
}

export function brusselsMoment(nowMs: number): ClockMoment {
  const parts = BRUSSELS_MOMENT_FORMATTER.formatToParts(nowMs);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  return { hour: Number(part('hour')), weekday: part('weekday').toLowerCase() };
}

/** Whether the block's hours cover the moment; a block that names a weekday must also match it. */
export function blockCoversMoment(block: HourBlock, moment: ClockMoment): boolean {
  if (block.weekday && block.weekday !== moment.weekday) return false;
  const wrapsMidnight = block.endHour <= block.startHour;
  return wrapsMidnight
    ? moment.hour >= block.startHour || moment.hour < block.endHour
    : moment.hour >= block.startHour && moment.hour < block.endHour;
}

export function isAvailableAtMoment(availableHours: string[], moment: ClockMoment): boolean {
  return availableHours.some((text) => {
    const block = parseHourBlock(text);
    return block !== null && blockCoversMoment(block, moment);
  });
}

/** `16-17u (dinsdag)`: the label of the hour that is running right now. */
export function formatMomentBlock(moment: ClockMoment): string {
  const pad = (hour: number) => String(hour).padStart(2, '0');
  return `${pad(moment.hour)}-${pad((moment.hour + 1) % 24)}u (${moment.weekday})`;
}

/**
 * Runners whose registration says they can run this hour, but who are not
 * warming up, waiting, or on the track. Runners hidden from the board stay out.
 * Those who have not run yet come first, so a first lap is never forgotten.
 */
export function findAvailableUncalledRunners(
  runners: Runner[],
  registrations: Record<string, RunnerRegistration>,
  moment: ClockMoment
): AvailableRunner[] {
  const available: AvailableRunner[] = [];
  for (const runner of runners) {
    if (runner.hiddenFromQueue) continue;
    if (runner.status !== 'registered' && runner.status !== 'ran') continue;
    const registration = registrations[runner.id];
    if (!registration || !isAvailableAtMoment(registration.availableHours, moment)) continue;
    available.push({ runner, phone: registration.phone.trim(), flexibility: registration.flexibility.trim() });
  }
  return available.sort(
    (first, second) =>
      Number(first.runner.status === 'ran') - Number(second.runner.status === 'ran') ||
      compareRunnerNumbers(first.runner.runnerNumber, second.runner.runnerNumber) ||
      first.runner.name.localeCompare(second.runner.name, 'nl-BE')
  );
}

function compareRunnerNumbers(first: string | null, second: string | null): number {
  if (first === second) return 0;
  if (first === null) return 1;
  if (second === null) return -1;
  return first.localeCompare(second, 'nl-BE', { numeric: true });
}
