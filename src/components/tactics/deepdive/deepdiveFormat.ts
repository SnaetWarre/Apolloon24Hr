import { workspaceChartPalette } from '../../../lib/chartPalette';
import { formatDurationMs } from '../../../lib/time';

export function teamColor(teamId: number, fallbackIndex = 0): string {
  if (teamId === 1) return workspaceChartPalette.live;
  if (teamId === 4) return workspaceChartPalette.rival;
  const alternatives = ['#009E73', '#D55E00', '#CC79A7', '#7F3FBF', '#8B4513', '#64748b'];
  return alternatives[fallbackIndex % alternatives.length];
}

export function formatSeconds(seconds: number): string {
  return formatDurationMs(seconds * 1_000);
}

export function formatNullableSeconds(seconds: number | null): string {
  return seconds == null ? 'Geen data' : formatSeconds(seconds);
}

export function formatSignedSeconds(seconds: number): string {
  return `${signedNumber(seconds, 0)}s`;
}

export function signedNumber(value: number, fractionDigits = 0): string {
  const roundedValue = Number(value.toFixed(fractionDigits));
  return `${roundedValue > 0 ? '+' : ''}${roundedValue.toLocaleString('nl-BE', { maximumFractionDigits: fractionDigits })}`;
}

export function percentage(part: number, total: number): string {
  return total ? `${((part / total) * 100).toFixed(1)}%` : '0%';
}
