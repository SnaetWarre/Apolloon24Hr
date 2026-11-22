import assert from 'node:assert/strict';

export function processCpuTicks(stat) {
  const end = stat.lastIndexOf(')');
  assert(end >= 0, 'missing process name');
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const user = Number(fields[11]);
  const system = Number(fields[12]);
  assert(Number.isSafeInteger(user) && user >= 0 && Number.isSafeInteger(system) && system >= 0, 'invalid CPU ticks');
  return user + system;
}
