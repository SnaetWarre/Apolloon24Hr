export function toLocalDateTime(ms: number): string {
  const date = new Date(ms);
  const local = new Date(ms - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function parseTeamWindow(start: string, end: string): { startsAt: number; endsAt: number } {
  const startsAt = new Date(start).getTime();
  const endsAt = new Date(end).getTime();
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
  }).format(ms);
}
