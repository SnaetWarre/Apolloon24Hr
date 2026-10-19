import { useAppActions } from '../../app/index';
import { useConfirm } from '../ConfirmDialog';
import type { RaceState } from '../../types';
import { useAdminAction } from './useAdminAction';
import { formatRelativeAge } from './adminFormat';
import { laptopWithAddress } from './useJoinGroup';

/**
 * Empties the race after a test run, on every linked laptop, so the real race starts from zero.
 * Alles wissen also removes the runners, for a laptop that starts over from an empty list.
 */
export function ClearRacePanel({ race }: { race: RaceState }) {
  const confirm = useConfirm();
  const { clearRace } = useAppActions();
  const { pending, run } = useAdminAction();
  const running = race.raceStartedAt !== null && race.raceFinishedAt === null;

  async function clear(runners: boolean) {
    if (pending) return;
    const confirmed = await confirm({
      title: runners ? 'Alles wissen?' : 'Race wissen?',
      message: (
        <>
          {runners ? (
            <>
              <p>
                Op alle gekoppelde laptops verdwijnen alle lopers met hun inschrijvingen, en alle rondes, wissels,
                Burgie-meldingen en de wachtrij. De race staat weer op niet gestart.
              </p>
              <p>Labels, logo's en instellingen blijven staan.</p>
            </>
          ) : (
            <>
              <p>
                Op alle gekoppelde laptops verdwijnen alle rondes, wissels, Burgie-meldingen en de wachtrij. De race
                staat weer op niet gestart en elke loper staat terug op ingeschreven.
              </p>
              <p>Lopers, labels, logo's en instellingen blijven staan.</p>
            </>
          )}
          {running && (
            <p>
              <strong>De race loopt nu.</strong> Wis alleen na de testrun, nooit tijdens de echte race.
            </p>
          )}
          <p>De huidige toestand wordt eerst als backup bewaard, dus je kan dit nog ongedaan maken.</p>
        </>
      ),
      confirmLabel: runners ? 'Alles wissen' : 'Race wissen',
      tone: 'danger',
    });
    if (!confirmed) return;
    await run(
      () => clearRace({ runners }),
      (result) => ({
        text: runners
          ? `Alles gewist: ${result.runners} lopers en ${result.laps} rondes weg.`
          : `Race gewist: ${result.laps} rondes weg.`,
        detail: `Ongedaan maken kan met de backup "Vóór race wissen" op ${laptopWithAddress({ name: result.safetyHostName, url: result.safetyHostUrl })}.`,
      }),
      runners ? 'Alles wissen mislukt' : 'Race wissen mislukt'
    );
  }

  return (
    <section className="panel">
      <h2>Race wissen na een testrun</h2>
      <p className="panel-copy">
        Haalt alle rondes en de wachtrij weg op alle gekoppelde laptops, zodat de echte race bij nul begint. Lopers en
        labels blijven staan. Alles wissen haalt ook alle lopers weg, voor een laptop die opnieuw begint.{' '}
        {race.raceStartedAt === null
          ? 'De race is nog niet gestart.'
          : `De race is ${formatRelativeAge(race.raceStartedAt)} gestart${race.raceFinishedAt === null ? ' en loopt nog' : ' en is afgesloten'}.`}
      </p>
      <div className="clear-race-actions">
        <button className="btn btn--danger" onClick={() => void clear(false)} disabled={pending}>
          {pending ? 'Wissen...' : 'Race wissen'}
        </button>
        <button className="btn btn--danger-outline" onClick={() => void clear(true)} disabled={pending}>
          Alles wissen
        </button>
      </div>
    </section>
  );
}
