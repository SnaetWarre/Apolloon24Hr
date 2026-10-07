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

const WEEKDAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];

/** The race runs 24 hours from Tuesday 20:00. */
const EVENT_START = { weekday: 'dinsdag', hour: 20 };
const EVENT_HOURS = 24;

export type HourGridDay = {
  weekday: string;
  hours: number[];
};

/** The event's one-hour slots, grouped per weekday, in running order. */
export function eventHourGrid(): HourGridDay[] {
  const days: HourGridDay[] = [];
  let weekday = EVENT_START.weekday;
  let hour = EVENT_START.hour;
  for (let index = 0; index < EVENT_HOURS; index += 1) {
    const day = days.at(-1);
    if (day?.weekday === weekday) day.hours.push(hour);
    else days.push({ weekday, hours: [hour] });
    hour = (hour + 1) % 24;
    if (hour === 0) weekday = WEEKDAYS[(weekdayIndex(weekday) + 1) % WEEKDAYS.length];
  }
  return days;
}

/**
 * Whether the list covers this hour: by its own one-hour block, or by a longer
 * one such as the form's `12-14u (woensdag)`.
 */
export function hasHourBlock(hourTexts: string[], weekday: string, hour: number): boolean {
  return hourTexts.some((text) => coversHour(text, weekday, hour));
}

export type HourSlot = {
  weekday: string;
  hour: number;
  /** `12-13u (woensdag)` */
  label: string;
};

/** The event's one-hour slots that at least one of the lists covers, in event order. */
export function coveredHourSlots(hourLists: string[][]): HourSlot[] {
  return eventHourGrid().flatMap(({ weekday, hours }) =>
    hours
      .filter((hour) => hourLists.some((hourTexts) => hasHourBlock(hourTexts, weekday, hour)))
      .map((hour) => ({ weekday, hour, label: formatMomentBlock({ hour, weekday }) }))
  );
}

/** Adds or removes the one-hour block, keeping the list in event order. */
export function toggleHourBlock(hourTexts: string[], weekday: string, hour: number): string[] {
  return setHourBlock(hourTexts, weekday, hour, !hasHourBlock(hourTexts, weekday, hour));
}

/**
 * Puts the hour in or out of the list. A new hour goes in as a one-hour block
 * in event order; taking an hour out of a longer block keeps its other hours.
 */
export function setHourBlock(hourTexts: string[], weekday: string, hour: number, selected: boolean): string[] {
  if (selected) {
    return hasHourBlock(hourTexts, weekday, hour)
      ? hourTexts
      : sortHourBlocks([...hourTexts, formatMomentBlock({ hour, weekday })]);
  }
  return hourTexts.flatMap((text) => {
    const block = parseHourBlock(text);
    if (!block || !blockCoversMoment(block, { hour, weekday })) return [text];
    return blockHours(block)
      .filter((blockHour) => blockHour !== hour)
      .map((blockHour) => formatHour(blockHour, block.weekday));
  });
}

export function sortHourBlocks(hourTexts: string[]): string[] {
  const position = (text: string) => {
    const block = parseHourBlock(text);
    return block?.weekday ? weekdayIndex(block.weekday) * 24 + block.startHour : Number.MAX_SAFE_INTEGER;
  };
  return [...hourTexts].sort(
    (first, second) => position(first) - position(second) || first.localeCompare(second, 'nl-BE', { numeric: true })
  );
}

function coversHour(text: string, weekday: string, hour: number): boolean {
  const block = parseHourBlock(text);
  return block !== null && blockCoversMoment(block, { hour, weekday });
}

function blockHours(block: HourBlock): number[] {
  const hours: number[] = [];
  for (let hour = block.startHour; hour !== block.endHour; hour = (hour + 1) % 24) hours.push(hour);
  return hours;
}

function formatHour(hour: number, weekday: string | null): string {
  if (weekday) return formatMomentBlock({ hour, weekday });
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hour)}-${pad((hour + 1) % 24)}u`;
}

function weekdayIndex(weekday: string): number {
  const index = WEEKDAYS.indexOf(weekday);
  return index === -1 ? WEEKDAYS.length : index;
}
