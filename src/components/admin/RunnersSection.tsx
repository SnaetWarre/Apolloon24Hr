import React from 'react';
import { useAppActions, useRegistrations } from '../../app/index';
import { useConfirm } from '../ConfirmDialog';
import { RunnerProfileModal } from '../RunnerProfileModal';
import { RunnerAddModal } from '../RunnerEntryModals';
import type { Runner } from '../../types';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';
import { AdminRunnerTable } from './AdminRunnerTable';
import { adminStatusText, foldSearchText, statusLabel } from '../../lib/runners';
import { statusOrder } from './adminFormat';
import { coveredHourSlots, hasHourBlock, searchableHourTexts } from '../../lib/availability';

const MAX_VISIBLE_RUNNERS = 150;

export function RunnersSection({ runners }: { runners: Runner[] }) {
  const confirm = useConfirm();
  const registrations = useRegistrations();
  const { deleteRunner, unhideRunner } = useAppActions();
  const { notice, setNotice, run } = useAdminAction();
  const [query, setQuery] = React.useState('');
  const [hour, setHour] = React.useState('');
  const [shown, setShown] = React.useState(MAX_VISIBLE_RUNNERS);
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);

  const hourSlots = coveredHourSlots(Object.values(registrations).map((registration) => registration.availableHours));
  const hourSlot = hourSlots.find((slot) => slot.label === hour);

  const q = foldSearchText(query.trim());
  const matchingRunners = runners
    .filter(
      (runner) =>
        !hourSlot || hasHourBlock(registrations[runner.id]?.availableHours ?? [], hourSlot.weekday, hourSlot.hour)
    )
    .filter((runner) => {
      if (!q) return true;
      const searchable = [
        runner.name,
        runner.runnerNumber || '',
        adminStatusText(runner),
        runner.registrationSource === 'import' ? 'Import' : 'Manueel',
        ...runner.labels.map((label) => label.name),
        ...searchableHourTexts(registrations[runner.id]?.availableHours ?? []),
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
          onChange={(event) => {
            setQuery(event.target.value);
            setShown(MAX_VISIBLE_RUNNERS);
          }}
          placeholder="Zoek op nummer, naam, label, status, bron of uur..."
        />
        <select
          className="input"
          aria-label="Beschikbaar tijdens"
          value={hour}
          onChange={(event) => {
            setHour(event.target.value);
            setShown(MAX_VISIBLE_RUNNERS);
          }}
        >
          <option value="">Alle beschikbare uren</option>
          {hourSlots.map((slot) => (
            <option key={slot.label} value={slot.label}>
              {slot.label}
            </option>
          ))}
        </select>
      </div>
      <p className="panel-copy" role="status">
        {matchingRunners.length} {matchingRunners.length === 1 ? 'loper' : 'lopers'} gevonden
        {hourSlot ? ` voor ${hourSlot.label}` : ''}
        {matchingRunners.length > shown ? ` · eerste ${shown} getoond` : ''}
        {statusCounts ? ` · ${statusCounts}` : ''}
      </p>
      {hourSlot && (
        <p className="panel-copy">
          Beschikbaarheid komt uit de inschrijving. De status toont de huidige stap in de app, niet de fysieke locatie.
        </p>
      )}
      <AdminNoticeBanner notice={notice} />
      <div className="table-wrap">
        <AdminRunnerTable
          runners={matchingRunners.slice(0, shown)}
          registrations={registrations}
          onOpenProfile={setProfileRunnerId}
          onRestore={restoreRunner}
          onRemove={removeRunner}
        />
      </div>
      {matchingRunners.length > shown && (
        <button className="btn btn--ghost" onClick={() => setShown((count) => count + MAX_VISIBLE_RUNNERS)}>
          Toon de volgende {Math.min(MAX_VISIBLE_RUNNERS, matchingRunners.length - shown)} lopers
        </button>
      )}
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
