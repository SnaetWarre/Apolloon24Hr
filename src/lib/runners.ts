import type { LapRecord, Runner } from '../types';

export function getNextWaitingRunner(runners: Runner[]): Runner | null {
  let nextRunner: Runner | null = null;
  for (const runner of runners) {
    if (runner.status !== 'waiting') continue;
    if (!nextRunner || (runner.queueIndex ?? 0) < (nextRunner.queueIndex ?? 0)) {
      nextRunner = runner;
    }
  }
  return nextRunner;
}

export function runnerLabel(runner: Pick<Runner, 'runnerNumber' | 'name'>): string {
  return runner.runnerNumber ? `${runner.runnerNumber} - ${runner.name}` : runner.name;
}

export function lapRunnerLabel(lap: Pick<LapRecord, 'runnerNumber' | 'runnerName'>): string {
  return lap.runnerNumber ? `${lap.runnerNumber} - ${lap.runnerName}` : lap.runnerName;
}
