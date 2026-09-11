import { labelKindOrder } from '../LabelBadge';
import type { Label, PublicRecordMode, Runner, RunnerStatus } from '../../types';

export function formatConflictTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.toLocaleTimeString('nl-BE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

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

export function statusLabel(status: RunnerStatus) {
  switch (status) {
    case 'registered':
      return 'Ingeschreven';
    case 'warming_up':
      return 'Aan het opwarmen';
    case 'waiting':
      return 'In de wachtrij';
    case 'running':
      return 'Loopt';
    case 'ran':
      return 'Heeft gelopen';
    default:
      return status;
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
    (a.runnerNumber || '').localeCompare(b.runnerNumber || '', undefined, { numeric: true }) ||
    a.name.localeCompare(b.name)
  );
}

export function groupLabels(labels: Label[]) {
  const grouped = new Map<string, typeof labels>();
  [...labels]
    .sort(
      (a, b) =>
        labelKindOrder(a.kind) - labelKindOrder(b.kind) ||
        (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) ||
        a.name.localeCompare(b.name)
    )
    .forEach((label) => {
      if (!grouped.has(label.kind)) grouped.set(label.kind, []);
      grouped.get(label.kind)?.push(label);
    });
  return [...grouped.entries()];
}
