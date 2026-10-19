import { LabelBadge } from '../LabelBadge';
import { SourceBadge } from '../RunnerEntryModals';
import { summarizeHours } from '../../lib/availability';
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
    <table className="runner-admin-table">
      <thead>
        <tr>
          <th className="num">Nr.</th>
          <th>Naam</th>
          <th>Status</th>
          <th>Beschikbaar</th>
          <th>Labels</th>
          <th>Bron</th>
          <th className="num">Toeren</th>
          <th>
            <span className="visually-hidden">Acties</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {runners.map((runner) => (
          // The name opens the profile; its overlay makes the whole row the target.
          <tr key={runner.id}>
            <td className="num runner-admin-table__muted">{runner.runnerNumber || '-'}</td>
            <td>
              <button type="button" className="runner-admin-table__open" onClick={() => onOpenProfile(runner.id)}>
                {runner.name}
              </button>
            </td>
            <td className="runner-admin-table__muted">{adminStatusText(runner)}</td>
            <td>
              <RunnerHours hours={registrations[runner.id]?.availableHours ?? []} />
            </td>
            <td>
              <div className="label-row">
                {runner.labels.map((label) => (
                  <LabelBadge key={label.id} label={label} compact />
                ))}
              </div>
            </td>
            <td>
              <SourceBadge source={runner.registrationSource} />
            </td>
            <td className="num">{runner.lapCount}</td>
            <td>
              <div className="runner-admin-actions">
                {runner.hiddenFromQueue && (
                  <button className="btn btn--sm" onClick={() => void onRestore(runner)}>
                    Terug tonen
                  </button>
                )}
                <button
                  className="btn btn--sm btn--quiet btn--danger-outline runner-admin-actions__remove"
                  onClick={() => void onRemove(runner)}
                  disabled={runner.lapCount > 0 || runner.status === 'running'}
                >
                  Verwijder
                </button>
              </div>
            </td>
          </tr>
        ))}
        {runners.length === 0 && (
          <tr>
            <td colSpan={8}>Geen lopers gevonden.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** A strip of the 24 race hours with the available ones filled, and the same hours as a few stretches. */
function RunnerHours({ hours }: { hours: string[] }) {
  if (!hours.length) return <span className="runner-admin-table__muted">Niet opgegeven</span>;
  const { slots, ranges } = summarizeHours(hours);
  return (
    <div className="runner-hours">
      <span className="runner-hours__strip" aria-hidden="true">
        {slots.map((slot, index) => (
          <span
            key={`${slot.weekday}-${slot.hour}`}
            className="runner-hours__slot"
            data-available={slot.available || undefined}
            data-new-day={(index > 0 && slots[index - 1].weekday !== slot.weekday) || undefined}
          />
        ))}
      </span>
      <span>{ranges.join(' · ')}</span>
    </div>
  );
}
