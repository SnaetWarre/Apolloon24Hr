import React from 'react';
import { useAppActions, useAppData, useRaceHistory } from '../../app/index';
import { reviewLaps, type LapFlag } from '../../lib/lapReview';
import { formatDurationMs } from '../../lib/time';
import type { LapRecord, LiveAppSnapshot, Runner } from '../../types';
import { useConfirm } from '../ConfirmDialog';
import { ModalDialog } from '../ModalDialog';
import { RunnerName } from '../RunnerName';
import { AdminNoticeBanner, useAdminAction } from './AdminNotice';

const PAGE_SIZE = 100;
/** Runners offered in the picker before anything is typed or after a search. */
const PICKER_SIZE = 8;

const selectRunners = ({ runners }: LiveAppSnapshot) => ({ runners });

type Fix = { kind: 'move' | 'split'; lap: LapRecord };

/**
 * Every lap run, newest first, with the three fixes a race needs: a lap that
 * went to the wrong runner, a missed press that made two laps into one, and a
 * press too many. Laps far from the usual lap time are marked, so they are
 * easy to find. Each fix is a line in Activiteit.
 */
export function LapsSection({ active }: { active: boolean }) {
  // The full lap history is only fetched while this tab is open.
  if (!active) return null;
  return <LapsPanel />;
}

function LapsPanel() {
  const history = useRaceHistory({ scope: 'full' });
  const { runners } = useAppData(selectRunners);
  const actions = useAppActions();
  const confirm = useConfirm();
  const { pending, notice, run } = useAdminAction();
  const [search, setSearch] = React.useState('');
  const [flaggedOnly, setFlaggedOnly] = React.useState(false);
  const [shown, setShown] = React.useState(PAGE_SIZE);
  const [fix, setFix] = React.useState<Fix | null>(null);

  const removeLap = async (lap: LapRecord) => {
    const confirmed = await confirm({
      title: 'Ronde verwijderen?',
      message: `${lapText(lap)} telt dan niet meer mee. Terugkrijgen kan alleen met een backup.`,
      confirmLabel: 'Verwijderen',
      tone: 'danger',
    });
    if (!confirmed) return;
    await run(() => actions.deleteLap(lap.id), `${lapText(lap)} is verwijderd.`, 'Verwijderen mislukt.');
  };

  const applyFix = async (current: Fix, runner: Runner) => {
    setFix(null);
    const name = runnerText(runner);
    if (current.kind === 'move') {
      await run(
        () => actions.moveLap(current.lap.id, runner.id),
        `${lapText(current.lap)} staat nu op ${name}.`,
        'Verplaatsen mislukt.'
      );
    } else {
      await run(
        () => actions.splitLap(current.lap.id, runner.id),
        `${lapText(current.lap)} is gesplitst in twee rondes van ${formatDurationMs(current.lap.durationMs / 2)}.`,
        'Splitsen mislukt.'
      );
    }
  };

  const review = reviewLaps(history.laps);
  const needle = search.trim().toLowerCase();
  const matching = history.laps.filter(
    (lap) =>
      (!flaggedOnly || review.flags.has(lap.id)) &&
      (!needle ||
        lap.runnerName.toLowerCase().includes(needle) ||
        (lap.runnerNumber ?? '').toLowerCase().includes(needle))
  );
  const visible = matching.slice(0, shown);

  return (
    <section className="panel">
      <h2>Rondes</h2>
      <p className="panel-copy">
        Elke gelopen ronde, de nieuwste bovenaan. Ging een ronde naar de verkeerde loper, werd een wissel gemist of werd
        er één keer te veel gedrukt? Verbeter het hier. Elke verbetering staat ook in Activiteit.
      </p>
      <div className="activity-toolbar">
        <input
          className="input"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Zoek op nummer of naam"
          aria-label="Rondes doorzoeken"
        />
        <label className="toggle-row">
          <input type="checkbox" checked={flaggedOnly} onChange={(event) => setFlaggedOnly(event.target.checked)} />
          Alleen opvallende rondes ({review.flags.size})
        </label>
      </div>
      <AdminNoticeBanner notice={notice} />
      {history.error ? (
        <div className="warning-banner" role="alert">
          De rondes konden niet geladen worden.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="laps-table">
            <thead>
              <tr>
                <th>Tijd</th>
                <th>Loper</th>
                <th>Ronde</th>
                <th>Rondetijd</th>
                <th>Opvallend</th>
                <th>
                  <span className="visually-hidden">Verbeteren</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((lap) => (
                <tr key={lap.id} className={review.flags.has(lap.id) ? 'laps-table__row--flagged' : undefined}>
                  <td className="laps-table__time">{formatMoment(lap.finishedAt)}</td>
                  <td>
                    <RunnerName runner={lapRunner(lap)} />
                  </td>
                  <td className="laps-table__number">{lap.lapNumber}</td>
                  <td className="laps-table__number">{formatDurationMs(lap.durationMs)}</td>
                  <td className="laps-table__flag">{flagText(review.flags.get(lap.id), review.medianMs)}</td>
                  <td className="laps-table__actions">
                    <button
                      className="btn btn--ghost btn--sm"
                      disabled={pending}
                      onClick={() => setFix({ kind: 'move', lap })}
                    >
                      Andere loper
                    </button>
                    <button
                      className="btn btn--ghost btn--sm"
                      disabled={pending}
                      onClick={() => setFix({ kind: 'split', lap })}
                    >
                      Splitsen
                    </button>
                    <button className="btn btn--ghost btn--sm" disabled={pending} onClick={() => void removeLap(lap)}>
                      Verwijderen
                    </button>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    {history.loading
                      ? 'Rondes laden…'
                      : history.laps.length
                        ? 'Geen rondes die passen.'
                        : 'Nog geen rondes gelopen.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {matching.length > shown && (
        <button className="btn btn--ghost" onClick={() => setShown((count) => count + PAGE_SIZE)}>
          Toon {Math.min(PAGE_SIZE, matching.length - shown)} oudere rondes
        </button>
      )}
      {fix && (
        <LapRunnerDialog
          fix={fix}
          laps={history.laps}
          runners={runners}
          onClose={() => setFix(null)}
          onPick={(runner) => void applyFix(fix, runner)}
        />
      )}
    </section>
  );
}

/** Picks the runner a lap goes to, or who ran the second half of a split lap. */
function LapRunnerDialog({
  fix,
  laps,
  runners,
  onClose,
  onPick,
}: {
  fix: Fix;
  laps: readonly LapRecord[];
  runners: readonly Runner[];
  onClose: () => void;
  onPick: (runner: Runner) => void;
}) {
  const { kind, lap } = fix;
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState('');
  // A split lap is most often one runner who ran twice, so that runner starts selected.
  const [selectedId, setSelectedId] = React.useState<string | null>(kind === 'split' ? lap.runnerId : null);

  const title = kind === 'move' ? 'Ronde naar andere loper' : 'Ronde splitsen';
  const suggestions = nearbyRunnerIds(laps, lap);
  const needle = query.trim().toLowerCase();
  const candidates = runners
    .filter((runner) => kind === 'split' || runner.id !== lap.runnerId)
    .filter(
      (runner) =>
        !needle ||
        runner.name.toLowerCase().includes(needle) ||
        (runner.runnerNumber ?? '').toLowerCase().includes(needle)
    )
    .sort((a, b) => rank(suggestions, a.id) - rank(suggestions, b.id) || compareNumbers(a, b))
    .slice(0, PICKER_SIZE);
  const selected = runners.find((runner) => runner.id === selectedId) ?? null;

  return (
    <ModalDialog label={title} onRequestClose={onClose} initialFocusRef={searchRef}>
      <div className="modal">
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn modal-close-btn" onClick={onClose} aria-label="Sluiten">
            ✕
          </button>
        </div>
        <p className="panel-copy">
          {kind === 'move'
            ? `${lapText(lap)}. Wie liep deze ronde echt?`
            : `${lapText(lap)}. Er werd een wissel gemist: de ronde wordt twee rondes van ${formatDurationMs(
                lap.durationMs / 2
              )}. De eerste blijft bij ${runnerText(lapRunner(lap))}. Wie liep de tweede?`}
        </p>
        <input
          ref={searchRef}
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Zoek op nummer of naam"
          aria-label="Loper zoeken"
        />
        <div className="laps-picker" role="radiogroup" aria-label="Loper">
          {candidates.map((runner) => (
            <label key={runner.id} className="laps-picker__option">
              <input
                type="radio"
                name="lap-runner"
                checked={runner.id === selectedId}
                onChange={() => setSelectedId(runner.id)}
              />
              <RunnerName runner={runner} />
              {runner.id === lap.runnerId && <small>dezelfde loper, twee keer</small>}
            </label>
          ))}
          {candidates.length === 0 && <p className="panel-copy">Geen loper gevonden.</p>}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Annuleer
          </button>
          <button className="btn btn--primary" disabled={!selected} onClick={() => selected && onPick(selected)}>
            {kind === 'move' ? 'Verplaatsen' : 'Splitsen'}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

/** The runners of the laps just before and after this one: the usual mix-ups at a handoff. */
function nearbyRunnerIds(laps: readonly LapRecord[], lap: LapRecord): string[] {
  const index = laps.findIndex((item) => item.id === lap.id);
  if (index < 0) return [];
  return laps.slice(Math.max(0, index - 3), index + 4).map((item) => item.runnerId);
}

function rank(suggestions: string[], id: string): number {
  const index = suggestions.indexOf(id);
  return index < 0 ? suggestions.length : Math.abs(index - Math.floor(suggestions.length / 2));
}

function compareNumbers(a: Runner, b: Runner): number {
  return (
    (a.runnerNumber ?? '').localeCompare(b.runnerNumber ?? '', 'nl', { numeric: true }) || a.name.localeCompare(b.name)
  );
}

function flagText(flag: LapFlag | undefined, medianMs: number | null): string {
  if (!flag || medianMs === null) return '';
  const usual = formatDurationMs(medianMs);
  return flag === 'short'
    ? `Veel korter dan gewoonlijk (${usual}). Eén keer te veel gedrukt?`
    : `Veel langer dan gewoonlijk (${usual}). Wissel gemist?`;
}

function runnerText(runner: Pick<Runner, 'name' | 'runnerNumber'>): string {
  return runner.runnerNumber ? `#${runner.runnerNumber} ${runner.name}` : runner.name;
}

function lapRunner(lap: LapRecord): Pick<Runner, 'name' | 'runnerNumber'> {
  return { name: lap.runnerName, runnerNumber: lap.runnerNumber };
}

function lapText(lap: LapRecord): string {
  return `Ronde ${lap.lapNumber} van ${runnerText(lapRunner(lap))} (${formatDurationMs(lap.durationMs)}, ${formatMoment(lap.finishedAt)})`;
}

function formatMoment(ms: number): string {
  return new Date(ms).toLocaleString('nl-BE', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
