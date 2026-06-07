import type { LapRecord, Runner } from '../types';

export function getNextWaitingRunner(runners: Runner[]): Runner | null {
  return (
    runners
      .filter((runner) => runner.status === 'waiting')
      .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0))[0] || null
  );
}

export function runnerLabel(runner: Pick<Runner, 'runnerNumber' | 'name'>): string {
  return runner.runnerNumber ? `${runner.runnerNumber} - ${runner.name}` : runner.name;
}

export function lapRunnerLabel(lap: Pick<LapRecord, 'runnerNumber' | 'runnerName'>): string {
  return lap.runnerNumber ? `${lap.runnerNumber} - ${lap.runnerName}` : lap.runnerName;
}
