import Papa from 'papaparse';
import type { Runner } from '../types';

export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function exportRunnersToCsv(runners: Runner[], nowMs: number): string {
  const rows = runners.map((r) => {
    const warmUpSec = r.status === 'warming_up' && r.statusSince ? Math.floor((nowMs - r.statusSince) / 1000) : '';
    const waitingSec = r.status === 'waiting' && r.statusSince ? Math.floor((nowMs - r.statusSince) / 1000) : '';
    const totalLaps = r.lapCount;
    const lastLapSec = r.lastLapMs != null ? Math.floor(r.lastLapMs / 1000) : '';
    return {
      runner_number: r.runnerNumber ?? '',
      name: r.name,
      labels: r.labels.map((label) => label.name).join(', '),
      status: r.status,
      warm_up_s: warmUpSec,
      waiting_s: waitingSec,
      queue_pos: r.queueIndex ?? '',
      laps: totalLaps,
      last_lap_s: lastLapSec,
      best_lap_s: r.bestLapMs != null ? Math.floor(r.bestLapMs / 1000) : '',
      average_lap_s: r.averageLapMs != null ? Math.floor(r.averageLapMs / 1000) : '',
    } as Record<string, string | number | ''>;
  });
  return Papa.unparse(rows, { header: true });
}

export async function importNamesFromCsvText(csvText: string): Promise<string[]> {
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  const data = (parsed.data as { name?: string }[]) || [];
  const names = data
    .map((r) => (r && r.name ? r.name.trim() : ''))
    .filter((n: string) => n.length > 0);
  return names;
}

