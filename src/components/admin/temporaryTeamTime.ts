// The race runs in Brussels, so these fields show and read Brussels time even when this browser is set to another zone.
const BRUSSELS_INPUT_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/Brussels',
});

/** Value for a datetime-local input: Brussels wall time, e.g. "2026-10-08T20:35". */
export function toLocalDateTime(ms: number): string {
  return BRUSSELS_INPUT_FORMATTER.format(ms).replace(' ', 'T');
}

function brusselsOffsetMs(ms: number): number {
  return Date.parse(`${toLocalDateTime(ms)}Z`) - Math.floor(ms / 60_000) * 60_000;
}

export function parseBrusselsDateTime(value: string): number {
  const asUtc = Date.parse(`${value}Z`);
  if (!Number.isFinite(asUtc)) return NaN;
  return asUtc - brusselsOffsetMs(asUtc - brusselsOffsetMs(asUtc));
}

export function parseTeamWindow(start: string, end: string): { startsAt: number; endsAt: number } {
  const startsAt = parseBrusselsDateTime(start);
  const endsAt = parseBrusselsDateTime(end);
  if (!start || !end || !Number.isFinite(startsAt) || !Number.isFinite(endsAt)) {
    throw new Error('Vul een geldig begin- en eindmoment in.');
  }
  if (endsAt <= startsAt)
    throw new Error('Het einduur moet na het beginuur liggen. Kies ook de juiste dag bij een nachtploeg.');
  return { startsAt, endsAt };
}

export function formatTeamWindow(ms: number): string {
  return new Intl.DateTimeFormat('nl-BE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Brussels',
  }).format(ms);
}
