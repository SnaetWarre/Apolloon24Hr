import React from 'react';
import { useAppActions, useRegistrations } from '../../app/index';
import { useConfirm } from '../ConfirmDialog';
import { RunnerProfileModal } from '../RunnerProfileModal';
import { RunnerAddModal } from '../RunnerEntryModals';
import type { Runner } from '../../types';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';
import { AdminRunnerTable } from './AdminRunnerTable';
import { foldSearchText, statusLabel } from '../../lib/runners';
import { statusOrder } from './adminFormat';

const MAX_VISIBLE_RUNNERS = 150;

export function RunnersSection({ runners }: { runners: Runner[] }) {
  const confirm = useConfirm();
  const registrations = useRegistrations();
  const { deleteRunner, unhideRunner } = useAppActions();
  const { notice, setNotice, run } = useAdminAction();
  const [query, setQuery] = React.useState('');
  const [hour, setHour] = React.useState('');
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);

  const availableHours = [
    ...new Set(Object.values(registrations).flatMap((registration) => registration.availableHours)),
  ].sort((a, b) => weekdayOrder(a) - weekdayOrder(b) || a.localeCompare(b, 'nl-BE', { numeric: true }));

  const q = foldSearchText(query.trim());
  const matchingRunners = runners
    .filter((runner) => !hour || registrations[runner.id]?.availableHours.includes(hour))
    .filter((runner) => {
      if (!q) return true;
      const searchable = [
        runner.name,
        runner.runnerNumber || '',
        runner.status,
        runner.registrationSource,
        ...runner.labels.map((label) => label.name),
        ...(registrations[runner.id]?.availableHours ?? []),
      ];
      return searchable.some((text) => foldSearchText(text).includes(q));
    })
    .sort(
      (a, b) =>
        statusOrder(a.status) - statusOrder(b.status) ||
        (a.runnerNumber || '').localeCompare(b.runnerNumber || '', undefined, { numeric: true }) ||
        a.name.localeCompare(b.name)
    );

  const counts = new Map<Runner['status'], number>();
  for (const runner of matchingRunners) counts.set(runner.status, (counts.get(runner.status) ?? 0) + 1);
  const statusCounts = [...counts.entries()]
    .sort(([a], [b]) => statusOrder(a) - statusOrder(b))
    .map(([status, count]) => `${statusLabel(status)}: ${count}`)
    .join(' · ');

  const restoreRunner = (runner: Runner) =>
    run(() => unhideRunner(runner.id), `${runner.name} is terug zichtbaar.`, 'Loper terug tonen mislukt').then(
      () => undefined
    );

  const removeRunner = async (runner: Runner) => {
    if (runner.lapCount > 0 || runner.status === 'running') return;
    const confirmed = await confirm({
      title: `${runner.name} definitief verwijderen?`,
      message: 'Dit kan niet ongedaan gemaakt worden.',
      confirmLabel: 'Definitief verwijderen',
      tone: 'danger',
    });
    if (confirmed)
      await run(() => deleteRunner(runner.id), `${runner.name} is definitief verwijderd.`, 'Loper verwijderen mislukt');
  };

  return (
    <section className="panel">
      <div className="panel-heading-row">
        <div>
          <h2>Lopers beheren</h2>
          <p className="panel-copy">
            Definitief verwijderen kan alleen voor lopers zonder rondes. Gelopen data blijft bewaard voor analyse.
          </p>
        </div>
        <button className="btn btn--primary" onClick={() => setAddOpen(true)}>
          Nieuwe loper
        </button>
      </div>
      <div className="form-row form-row--plain">
        <input
          className="input input--stretch"
          aria-label="Lopers zoeken"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Zoek op nummer, naam, label, status, bron of uur..."
        />
        <select
          className="input"
          aria-label="Beschikbaar tijdens"
          value={hour}
          onChange={(event) => setHour(event.target.value)}
        >
          <option value="">Alle beschikbare uren</option>
          {availableHours.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <p className="panel-copy" role="status">
        {matchingRunners.length} {matchingRunners.length === 1 ? 'loper' : 'lopers'} gevonden
        {hour ? ` voor ${hour}` : ''}
        {matchingRunners.length > MAX_VISIBLE_RUNNERS ? ` · eerste ${MAX_VISIBLE_RUNNERS} getoond` : ''}
        {statusCounts ? ` · ${statusCounts}` : ''}
      </p>
      {hour && (
        <p className="panel-copy">
          Beschikbaarheid komt uit de inschrijving. De status toont de huidige stap in de app, niet de fysieke locatie.
        </p>
      )}
      <AdminNoticeBanner notice={notice} />
      <div className="table-wrap">
        <AdminRunnerTable
          runners={matchingRunners.slice(0, MAX_VISIBLE_RUNNERS)}
          registrations={registrations}
          onOpenProfile={setProfileRunnerId}
          onRestore={restoreRunner}
          onRemove={removeRunner}
        />
      </div>
      {profileRunnerId && <RunnerProfileModal runnerId={profileRunnerId} onClose={() => setProfileRunnerId(null)} />}
      {addOpen && (
        <RunnerAddModal
          destination="registered"
          onClose={() => setAddOpen(false)}
          onAdded={() => setNotice({ tone: 'success', text: 'Loper toegevoegd.' })}
        />
      )}
    </section>
  );
}

/** Registration hours read "dinsdag 20u-22u"; the event runs Tuesday to Thursday. */
function weekdayOrder(hour: string): number {
  const lower = hour.toLowerCase();
  return lower.includes('dinsdag') ? 0 : lower.includes('woensdag') ? 1 : 2;
}
