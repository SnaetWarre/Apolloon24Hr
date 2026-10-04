import type { PublicRecordMode, Runner, RunnerStatus } from '../../types';

export function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1_024 ** 3).toFixed(1)} GiB`;
}

export function formatRelativeAge(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'zonet';
  if (minutes === 1) return '1 minuut geleden';
  if (minutes < 60) return `${minutes} minuten geleden`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 uur geleden';
  if (hours < 48) return `${hours} uur geleden`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 dag geleden' : `${days} dagen geleden`;
}

export function statusOrder(status: RunnerStatus) {
  switch (status) {
    case 'running':
      return 0;
    case 'waiting':
      return 1;
    case 'warming_up':
      return 2;
    case 'ran':
      return 3;
    case 'registered':
      return 4;
    default:
      return 5;
  }
}

export function publicRecordModeLabel(mode: PublicRecordMode) {
  if (mode === 'off') return 'uit';
  if (mode === 'hour') return 'per uur';
  if (mode === 'two_hour') return 'per 2 uur';
  return 'dagrecord';
}

export function compareRunnerIdentity(a: Runner, b: Runner) {
  return (
    (a.runnerNumber || '').localeCompare(b.runnerNumber || '', undefined, {
      numeric: true,
    }) || a.name.localeCompare(b.name)
  );
}

/** The speedteam a runner runs for now, which may be a night team. */
export function currentTeamName(runner: Runner): string {
  return (
    runner.labels.find((label) => label.kind === 'speedteam' || label.kind === 'temporary_team')?.name ??
    'Geen speedteam'
  );
}
