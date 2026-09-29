import React from 'react';
import { useAppActions, useRegistrations } from '../../app/index';
import { useConfirm } from '../ConfirmDialog';
import { RunnerProfileModal } from '../RunnerProfileModal';
import type { Runner } from '../../types';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';
import { AdminRunnerTable } from './AdminRunnerTable';
import { statusLabel, statusOrder } from './adminFormat';

const MAX_VISIBLE_RUNNERS = 150;

export function RunnersSection({ runners }: { runners: Runner[] }) {
  const confirm = useConfirm();
  const registrations = useRegistrations();
  const { deleteRunner, unhideRunner } = useAppActions();
  const { notice, run } = useAdminAction();
  const [query, setQuery] = React.useState('');
  const [hour, setHour] = React.useState('');
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);

  const availableHours = React.useMemo(
    () =>
      [...new Set(Object.values(registrations).flatMap((registration) => registration.availableHours))].sort(
        (a, b) => weekdayOrder(a) - weekdayOrder(b) || a.localeCompare(b, 'nl-BE', { numeric: true })
      ),
    [registrations]
  );

  const matchingRunners = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return runners
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
        return searchable.some((text) => text.toLowerCase().includes(q));
      })
      .sort(
        (a, b) =>
          statusOrder(a.status) - statusOrder(b.status) ||
          (a.runnerNumber || '').localeCompare(b.runnerNumber || '', undefined, { numeric: true }) ||
          a.name.localeCompare(b.name)
      );
  }, [hour, query, registrations, runners]);

  const statusCounts = React.useMemo(() => {
    const counts = new Map<Runner['status'], number>();
    for (const runner of matchingRunners) counts.set(runner.status, (counts.get(runner.status) ?? 0) + 1);
    return [...counts.entries()]
      .sort(([a], [b]) => statusOrder(a) - statusOrder(b))
      .map(([status, count]) => `${statusLabel(status)}: ${count}`)
      .join(' · ');
  }, [matchingRunners]);

  const restoreRunner = React.useCallback(
    (runner: Runner) =>
      run(() => unhideRunner(runner.id), `${runner.name} is terug zichtbaar.`, 'Loper terug tonen mislukt').then(
        () => undefined
      ),
    [run, unhideRunner]
  );

  const removeRunner = React.useCallback(
    async (runner: Runner) => {
      if (runner.lapCount > 0 || runner.status === 'running') return;
      const confirmed = await confirm({
        title: `${runner.name} definitief verwijderen?`,
        message: 'Dit kan niet ongedaan gemaakt worden.',
        confirmLabel: 'Definitief verwijderen',
        tone: 'danger',
      });
      if (confirmed)
        await run(
          () => deleteRunner(runner.id),
          `${runner.name} is definitief verwijderd.`,
          'Loper verwijderen mislukt'
        );
    },
    [confirm, deleteRunner, run]
  );

  return (
    <section className="panel">
      <h2>Lopers beheren</h2>
      <p className="panel-copy">
        Definitief verwijderen kan alleen voor lopers zonder rondes. Gelopen data blijft bewaard voor analyse.
      </p>
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
    </section>
  );
}

/** Registration hours read "dinsdag 20u-22u"; the event runs Tuesday to Thursday. */
function weekdayOrder(hour: string): number {
  const lower = hour.toLowerCase();
  return lower.includes('dinsdag') ? 0 : lower.includes('woensdag') ? 1 : 2;
}
