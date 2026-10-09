import { foldSearchText } from '../../shared/search';
import type { LapRecord, Runner, RunnerStatus } from '../types';

export { foldSearchText };

/** The server's queue order: place in line, then who joined first when two share a place. */
export function compareWaitingOrder(
  a: Pick<Runner, 'queueIndex' | 'statusSince'>,
  b: Pick<Runner, 'queueIndex' | 'statusSince'>
): number {
  return (
    (a.queueIndex ?? Number.MAX_SAFE_INTEGER) - (b.queueIndex ?? Number.MAX_SAFE_INTEGER) ||
    (a.statusSince ?? Number.MAX_SAFE_INTEGER) - (b.statusSince ?? Number.MAX_SAFE_INTEGER)
  );
}

export function getNextWaitingRunner(runners: Runner[]): Runner | null {
  let nextRunner: Runner | null = null;
  for (const runner of runners) {
    if (runner.status !== 'waiting') continue;
    if (!nextRunner || compareWaitingOrder(runner, nextRunner) < 0) nextRunner = runner;
  }
  return nextRunner;
}

export function lapRunnerLabel(lap: Pick<LapRecord, 'runnerNumber' | 'runnerName'>): string {
  return lap.runnerNumber ? `${lap.runnerNumber} ${lap.runnerName}` : lap.runnerName;
}

/** "149 Bram Lenaerts", or the name alone without a number. */
export function runnerLabel(runner: Pick<Runner, 'runnerNumber' | 'name'>): string {
  return lapRunnerLabel({ runnerNumber: runner.runnerNumber, runnerName: runner.name });
}

/** The same words for a runner's status on every screen. */
export function statusLabel(status: RunnerStatus): string {
  switch (status) {
    case 'registered':
      return 'Ingeschreven';
    case 'warming_up':
      return 'Aan het opwarmen';
    case 'waiting':
      return 'In de wachtrij';
    case 'running':
      return 'Op de piste';
    case 'ran':
      return 'Heeft gelopen';
    default:
      return status;
  }
}

/** The status Beheer › Lopers shows, with "· verborgen" for a runner hidden from the queue. */
export function adminStatusText(runner: Pick<Runner, 'status' | 'hiddenFromQueue'>): string {
  return runner.hiddenFromQueue ? `${statusLabel(runner.status)} · verborgen` : statusLabel(runner.status);
}

/** Whether a runner matches a search: number, name, and labels together, so "149 bram" finds Bram with 149. */
export function runnerMatchesSearch(runner: Pick<Runner, 'runnerNumber' | 'name' | 'labels'>, query: string): boolean {
  const q = foldSearchText(query.trim());
  if (!q) return true;
  return foldSearchText(
    `${runner.runnerNumber ?? ''} ${runner.name} ${runner.labels.map((label) => label.name).join(' ')}`
  ).includes(q);
}
