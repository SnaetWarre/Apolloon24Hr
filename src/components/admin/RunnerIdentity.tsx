import type { Runner } from '../../types';

export function RunnerIdentity({ runner, detail }: { runner: Runner; detail?: string }) {
  const baseTeam = runner.labels.find((label) => label.kind === 'speedteam');
  return (
    <div className="temporary-team-runner-identity">
      <strong>{runner.runnerNumber ? `${runner.runnerNumber} - ` : ''}{runner.name}</strong>
      <span>{detail || baseTeam?.name || 'Geen speedteam'}</span>
    </div>
  );
}
