import Papa from 'papaparse';
import type { Runner } from '../types';

export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function exportRunnersToCsv(runners: Runner[], nowMs: number): string {
  const rows = runners.map((r) => {
    const warmUpSec = r.status === 'warming_up' && r.statusSince ? Math.floor((nowMs - r.statusSince) / 1000) : '';
    const waitingSec = r.status === 'waiting' && r.statusSince ? Math.floor((nowMs - r.statusSince) / 1000) : '';
    const totalLaps = r.laps?.length ?? 0;
    const lastLapMs = totalLaps > 0 ? r.laps[totalLaps - 1].durationMs : undefined;
    const lastLapSec = lastLapMs != null ? Math.floor(lastLapMs / 1000) : '';
    return {
      name: r.name,
      status: r.status,
      warm_up_s: warmUpSec,
      waiting_s: waitingSec,
      manual_run_time_s: r.manualRunTimeSec ?? '',
      queue_pos: r.queueIndex ?? '',
      laps: totalLaps,
      last_lap_s: lastLapSec,
    } as Record<string, string | number | ''>;
  });
  return Papa.unparse(rows, { header: true });
}

export async function importNamesFromCsvText(csvText: string): Promise<string[]> {
  const parsed = Papa.parse<{ name: string }>(csvText, { header: true, skipEmptyLines: true });
  const names = parsed.data
    .map((r) => (r && r.name ? r.name.trim() : ''))
    .filter((n) => n.length > 0);
  return names;
}


