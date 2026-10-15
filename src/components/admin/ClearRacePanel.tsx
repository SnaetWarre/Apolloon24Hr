import { useAppActions } from '../../app/index';
import { useConfirm } from '../ConfirmDialog';
import type { RaceState } from '../../types';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';
import { formatRelativeAge } from './adminFormat';
import { laptopWithAddress } from './useJoinGroup';

/** Empties the race after a test run, on every linked laptop, so the real race starts from zero. */
export function ClearRacePanel({ race }: { race: RaceState }) {
  const confirm = useConfirm();
  const { clearRace } = useAppActions();
  const { pending, notice, run } = useAdminAction();
  const running = race.raceStartedAt !== null && race.raceFinishedAt === null;

  async function clear() {
    if (pending) return;
    const confirmed = await confirm({
      title: 'Race wissen?',
      message: (
        <>
          <p>
            Op alle gekoppelde laptops verdwijnen alle rondes, wissels, Burgie-meldingen en de wachtrij. De race staat
            weer op niet gestart en elke loper staat terug op ingeschreven.
          </p>
          <p>Lopers, labels, logo's en instellingen blijven staan.</p>
          {running && (
            <p>
              <strong>De race loopt nu.</strong> Wis alleen na de testrun, nooit tijdens de echte race.
            </p>
          )}
          <p>De huidige toestand wordt eerst als backup bewaard, dus je kan dit nog ongedaan maken.</p>
        </>
      ),
      confirmLabel: 'Race wissen',
      tone: 'danger',
    });
    if (!confirmed) return;
    await run(
      () => clearRace(),
      (result) =>
        `Race gewist: ${result.laps} rondes weg. De toestand van daarvoor staat op laptop ${laptopWithAddress({ name: result.safetyHostName, url: result.safetyHostUrl })}, in ${result.safetyBackup}. Zet die backup terug om dit ongedaan te maken.`,
      'Race wissen mislukt'
    );
  }

  return (
    <section className="panel">
      <h2>Race wissen na een testrun</h2>
      <p className="panel-copy">
        Haalt alle rondes en de wachtrij weg op alle gekoppelde laptops, zodat de echte race bij nul begint. Lopers en
        labels blijven staan.{' '}
        {race.raceStartedAt === null
          ? 'De race is nog niet gestart.'
          : `De race is ${formatRelativeAge(race.raceStartedAt)} gestart${race.raceFinishedAt === null ? ' en loopt nog' : ' en is afgesloten'}.`}
      </p>
      <button className="btn btn--danger" onClick={() => void clear()} disabled={pending}>
        {pending ? 'Wissen...' : 'Race wissen'}
      </button>
      <AdminNoticeBanner notice={notice} />
    </section>
  );
}
