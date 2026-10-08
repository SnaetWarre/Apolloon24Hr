import { LabelBadge } from '../LabelBadge';
import { SourceBadge } from '../RunnerEntryModals';
import { adminStatusText } from '../../lib/runners';
import type { Runner, RunnerRegistration } from '../../types';

export function AdminRunnerTable({
  runners,
  registrations,
  onOpenProfile,
  onRestore,
  onRemove,
}: {
  runners: Runner[];
  registrations: Record<string, RunnerRegistration>;
  onOpenProfile: (runnerId: string) => void;
  onRestore: (runner: Runner) => Promise<void>;
  onRemove: (runner: Runner) => Promise<void>;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Nr.</th>
          <th>Naam</th>
          <th>Status</th>
          <th>Beschikbare uren</th>
          <th>Bron</th>
          <th>Labels</th>
          <th>Toeren</th>
          <th>Acties</th>
        </tr>
      </thead>
      <tbody>
        {runners.map((runner) => {
          const hours = registrations[runner.id]?.availableHours ?? [];
          return (
            <tr key={runner.id}>
              <td>{runner.runnerNumber || '-'}</td>
              <td>{runner.name}</td>
              <td>{adminStatusText(runner)}</td>
              <td>{hours.length ? hours.join(', ') : 'Niet opgegeven'}</td>
              <td>
                <SourceBadge source={runner.registrationSource} />
              </td>
              <td>
                <div className="label-row">
                  {runner.labels.map((label) => (
                    <LabelBadge key={label.id} label={label} compact />
                  ))}
                </div>
              </td>
              <td>{runner.lapCount}</td>
              <td>
                <div className="runner-admin-actions">
                  <button className="btn btn--sm" onClick={() => onOpenProfile(runner.id)}>
                    Profiel
                  </button>
                  {runner.hiddenFromQueue && (
                    <button className="btn btn--sm" onClick={() => void onRestore(runner)}>
                      Terug tonen
                    </button>
                  )}
                  <button
                    className="btn btn--sm btn--quiet btn--danger-outline"
                    onClick={() => void onRemove(runner)}
                    disabled={runner.lapCount > 0 || runner.status === 'running'}
                  >
                    Verwijder
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
        {runners.length === 0 && (
          <tr>
            <td colSpan={8}>Geen lopers gevonden.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
