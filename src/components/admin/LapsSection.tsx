import React from 'react';
import { useAppActions, useAppData, useRaceHistory } from '../../app/index';
import { MAX_HANDOFF_SHIFT_MS, MIN_LAP_MS } from '../../../shared/lapTimes';
import { reviewHandoffs, reviewLaps, type HandoffHint, type LapFlag } from '../../lib/lapReview';
import { useArrivals } from '../../lib/motion';
import { runnerMatchesSearch } from '../../lib/runners';
import { formatClockTimeMs, formatDurationMs, nowMs } from '../../lib/time';
import type { LapRecord, LiveAppSnapshot, RaceState, Runner } from '../../types';
import { useConfirm } from '../ConfirmDialog';
import { ModalDialog } from '../ModalDialog';
import { RunnerName } from '../RunnerName';
import { useAdminAction } from './useAdminAction';

const PAGE_SIZE = 100;
/** Runners offered in the picker before anything is typed or after a search. */
const PICKER_SIZE = 8;

const selectLapData = ({ runners, race }: LiveAppSnapshot) => ({ runners, race });

type Fix = { kind: 'move' | 'split'; lap: LapRecord };

/**
 * Every lap run, newest first, with the fixes a race needs: a press that came too
 * late or too early, a lap that went to the wrong runner, a missed press that made
 * two laps into one, and a press too many. A click on a lap opens its fixes beside
 * the list. Laps far from the usual lap time, and presses that look late, are
 * marked, so they are easy to find. Each fix is a line in Activiteit.
 */
export function LapsSection({ active }: { active: boolean }) {
  // The full lap history is only fetched while this tab is open.
  if (!active) return null;
  return <LapsPanel />;
}

function LapsPanel() {
  const history = useRaceHistory({ scope: 'full' });
  const { runners, race } = useAppData(selectLapData);
  const actions = useAppActions();
  const confirm = useConfirm();
  const { pending, run } = useAdminAction();
  const [search, setSearch] = React.useState('');
  const [flaggedOnly, setFlaggedOnly] = React.useState(false);
  const [shown, setShown] = React.useState(PAGE_SIZE);
  const [fix, setFix] = React.useState<Fix | null>(null);
  // The lap clicked, and the lap that ends at the press the panel moves.
  const [selected, setSelected] = React.useState<{ lapId: string; pressLapId: string | null } | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [pointerInside, setPointerInside] = React.useState(false);
  // While the operator works on the table, laps that finish later wait, so no row moves under the mouse.
  const [holdAfter, setHoldAfter] = React.useState(Number.POSITIVE_INFINITY);
  const holding = pointerInside || fix !== null || confirming;

  const enterTable = () => {
    if (!holding) setHoldAfter(history.laps.reduce((newest, lap) => Math.max(newest, lap.finishedAt), 0));
    setPointerInside(true);
  };

  const removeLap = async (lap: LapRecord) => {
    setConfirming(true);
    const confirmed = await confirm({
      title: 'Ronde verwijderen?',
      message: `${lapText(lap)} telt dan niet meer mee. Terugkrijgen kan alleen met een backup.`,
      confirmLabel: 'Verwijderen',
      tone: 'danger',
    });
    setConfirming(false);
    if (!confirmed) return;
    await run(() => actions.deleteLap(lap.id), `${lapText(lap)} is verwijderd.`, 'Verwijderen mislukt.');
  };

  const movePress = async (before: LapRecord, to: number) => {
    const after = history.laps.find((lap) => lap.startedAt === before.finishedAt);
    const next = after ? lapRunner(after) : runningRunner(race, runners);
    const shift = to - before.finishedAt;
    await run(
      () => actions.moveHandoff(before.id, before.finishedAt, to),
      `Wissel van ${runnerText(lapRunner(before))} naar ${next ? runnerText(next) : 'de volgende loper'} ${shiftText(shift, false)} gezet.`,
      'Verschuiven mislukt.'
    );
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
  const hints = reviewHandoffs(history.laps);
  const lapAfter = new Map(history.laps.map((lap) => [lap.startedAt, lap]));
  const lapBefore = new Map(history.laps.map((lap) => [lap.finishedAt, lap]));
  // Both laps around a press that looks late are marked, each by how far it is off its runner's usual time.
  const offUsual = new Map<string, number>();
  for (const [lapId, hint] of hints) {
    const before = history.laps.find((lap) => lap.id === lapId);
    const after = before && lapAfter.get(before.finishedAt);
    if (!before || !after) continue;
    offUsual.set(before.id, before.durationMs - hint.usualBeforeMs);
    offUsual.set(after.id, after.durationMs - hint.usualAfterMs);
  }
  const marked = (lap: LapRecord) => review.flags.has(lap.id) || offUsual.has(lap.id);
  const hasPressAfter = (lap: LapRecord) =>
    lapAfter.has(lap.finishedAt) || (race.activeRunnerId !== null && race.activeStartedAt === lap.finishedAt);
  /** The lap that ends at the press the panel opens on: a press that looks late next to the lap, else the one after it. */
  const pressLapFor = (lap: LapRecord) => {
    const before = lapBefore.get(lap.startedAt) ?? null;
    if (hints.has(lap.id)) return lap;
    if (before && hints.has(before.id)) return before;
    return hasPressAfter(lap) ? lap : before;
  };
  const selectedLap = selected ? history.laps.find((lap) => lap.id === selected.lapId) : undefined;
  const pressLap = selected?.pressLapId ? history.laps.find((lap) => lap.id === selected.pressLapId) : undefined;
  // Split halves and moved laps finish no later than the lap they came from, so the operator's own fixes still show.
  const laps = holding ? history.laps.filter((lap) => lap.finishedAt <= holdAfter) : history.laps;
  const heldCount = history.laps.length - laps.length;
  const newLapIds = useArrivals(
    laps.map((lap) => lap.id),
    history.initialized
  );
  const matching = laps.filter(
    (lap) =>
      (!flaggedOnly || marked(lap)) &&
      runnerMatchesSearch({ runnerNumber: lap.runnerNumber, name: lap.runnerName, labels: [] }, search)
  );
  const visible = matching.slice(0, shown);

  return (
    <div className="laps-layout">
      <section className="panel laps-list">
        <h2>Rondes</h2>
        <p className="panel-copy">
          Elke gelopen ronde, de nieuwste bovenaan. Klik op een ronde om ze te verbeteren: een wissel te laat of te
          vroeg gedrukt, de verkeerde loper, een gemiste wissel of één keer te veel gedrukt. Elke verbetering staat ook
          in Activiteit.
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
            Alleen opvallende rondes ({history.laps.filter(marked).length})
          </label>
          <span className="laps-held" role="status">
            {heldCount > 0 && `${heldCount} ${heldCount === 1 ? 'nieuwe ronde' : 'nieuwe rondes'}`}
          </span>
        </div>
        {history.error ? (
          <div className="warning-banner" role="alert">
            De rondes konden niet geladen worden.
          </div>
        ) : (
          <div className="table-wrap" onPointerEnter={enterTable} onPointerLeave={() => setPointerInside(false)}>
            <table className="laps-table">
              <thead>
                <tr>
                  <th>Tijd</th>
                  <th>Loper</th>
                  <th>Ronde</th>
                  <th>Rondetijd</th>
                  <th>Opvallend</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((lap, index) => {
                  const older = visible[index + 1];
                  const hint = older && lapAfter.get(older.finishedAt) === lap ? hints.get(older.id) : undefined;
                  return (
                    <React.Fragment key={lap.id}>
                      <tr
                        className={
                          [
                            marked(lap) && 'laps-table__row--flagged',
                            lap.id === selectedLap?.id && 'is-selected',
                            newLapIds.has(lap.id) && 'is-new',
                          ]
                            .filter(Boolean)
                            .join(' ') || undefined
                        }
                      >
                        <td className="laps-table__time">
                          <button
                            className="laps-table__open"
                            aria-pressed={lap.id === selectedLap?.id}
                            onClick={() => setSelected({ lapId: lap.id, pressLapId: pressLapFor(lap)?.id ?? null })}
                          >
                            {formatMoment(lap.finishedAt)}
                          </button>
                        </td>
                        <td>
                          <RunnerName runner={lapRunner(lap)} />
                        </td>
                        <td className="laps-table__number">{lap.lapNumber}</td>
                        <td className="laps-table__number">{formatDurationMs(lap.durationMs)}</td>
                        <td className="laps-table__flag">
                          {offUsual.has(lap.id)
                            ? offUsualText(offUsual.get(lap.id)!)
                            : flagText(review.flags.get(lap.id), review.medianMs)}
                        </td>
                      </tr>
                      {hint && (
                        <tr className="laps-table__seam">
                          <td colSpan={5}>
                            <span className="laps-seam">
                              Wissel <strong>{shiftText(hint.shiftMs, true)}</strong> gedrukt?
                              <button
                                className="btn btn--sm"
                                onClick={() => setSelected({ lapId: older.id, pressLapId: older.id })}
                              >
                                Bekijken
                              </button>
                            </span>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={5}>
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
      </section>
      <aside className="panel laps-fix" aria-label="Ronde verbeteren">
        {selectedLap ? (
          <>
            <div className="laps-fix__header">
              <div>
                <h2>
                  Ronde {selectedLap.lapNumber} van {runnerText(lapRunner(selectedLap))}
                </h2>
                <p className="panel-copy">
                  {formatDurationMs(selectedLap.durationMs)}, gelopen van {formatClockTimeMs(selectedLap.startedAt)} tot{' '}
                  {formatClockTimeMs(selectedLap.finishedAt)}
                </p>
              </div>
              <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Sluiten">
                ✕
              </button>
            </div>
            <PressChoice
              lap={selectedLap}
              before={lapBefore.get(selectedLap.startedAt)}
              after={lapAfter.get(selectedLap.finishedAt)}
              running={
                hasPressAfter(selectedLap) && !lapAfter.has(selectedLap.finishedAt)
                  ? runningRunner(race, runners)
                  : null
              }
              pressLapId={pressLap?.id ?? null}
              onChoose={(pressLapId) => setSelected({ lapId: selectedLap.id, pressLapId })}
            />
            {pressLap && (
              <PressEditor
                key={`${pressLap.id}:${pressLap.finishedAt}`}
                before={pressLap}
                after={lapAfter.get(pressLap.finishedAt) ?? null}
                running={lapAfter.has(pressLap.finishedAt) ? null : runningRunner(race, runners)}
                runningSince={race.activeStartedAt}
                hint={hints.get(pressLap.id)}
                pending={pending}
                onMove={(to) => void movePress(pressLap, to)}
              />
            )}
            <div className="laps-fix__other">
              <h3>Iets anders mis met deze ronde?</h3>
              <div className="laps-fix__buttons">
                <button className="btn" disabled={pending} onClick={() => setFix({ kind: 'move', lap: selectedLap })}>
                  Andere loper
                </button>
                <button className="btn" disabled={pending} onClick={() => setFix({ kind: 'split', lap: selectedLap })}>
                  Splitsen
                </button>
                <button className="btn" disabled={pending} onClick={() => void removeLap(selectedLap)}>
                  Verwijderen
                </button>
              </div>
            </div>
          </>
        ) : (
          <p className="laps-fix__empty">
            Klik op een ronde om ze te verbeteren. Een wissel die te laat of te vroeg gedrukt werd, schuif je hier met
            knoppen van een seconde.
          </p>
        )}
      </aside>
      {fix && (
        <LapRunnerDialog
          fix={fix}
          laps={history.laps}
          runners={runners}
          onClose={() => setFix(null)}
          onPick={(runner) => void applyFix(fix, runner)}
        />
      )}
    </div>
  );
}

/** Which press the panel moves, when the lap has one on both ends, named by the runners on each side. */
function PressChoice({
  lap,
  before,
  after,
  running,
  pressLapId,
  onChoose,
}: {
  lap: LapRecord;
  before: LapRecord | undefined;
  after: LapRecord | undefined;
  running: Pick<Runner, 'name' | 'runnerNumber'> | null;
  pressLapId: string | null;
  onChoose: (pressLapId: string) => void;
}) {
  const next = after ? lapRunner(after) : running;
  if (!before || !next) return null;
  return (
    <div className="segmented-control" role="group" aria-label="Welke wissel">
      {[
        { id: before.id, text: `Van ${lapRunner(before).name} naar ${lap.runnerName}` },
        { id: lap.id, text: `Van ${lap.runnerName} naar ${next.name}` },
      ].map((option) => (
        <button
          key={option.id}
          className={option.id === pressLapId ? 'is-active' : undefined}
          aria-pressed={option.id === pressLapId}
          onClick={() => onChoose(option.id)}
        >
          {option.text}
        </button>
      ))}
    </div>
  );
}

const NUDGES_MS = [-1_000, -100, 100, 1_000];

/**
 * Moves one press with buttons of a second and a tenth, the way the fix is asked for: "Mitras −4,
 * Wout +4". The buttons change the lap before the press; the lap after it changes the other way.
 */
function PressEditor({
  before,
  after,
  running,
  runningSince,
  hint,
  pending,
  onMove,
}: {
  before: LapRecord;
  after: LapRecord | null;
  running: Pick<Runner, 'name' | 'runnerNumber'> | null;
  runningSince: number | null;
  hint: HandoffHint | undefined;
  pending: boolean;
  onMove: (to: number) => void;
}) {
  const [shiftMs, setShiftMs] = React.useState(0);
  // The runner on the track has no lap time yet: what they ran so far, when the panel opened, stands in for it.
  const [afterMs] = React.useState(() => after?.durationMs ?? nowMs() - (runningSince ?? before.finishedAt));
  const nextRunner = after ? lapRunner(after) : running;
  if (!nextRunner) return null;
  const allowed = (shift: number) =>
    Math.abs(shift) <= MAX_HANDOFF_SHIFT_MS &&
    before.durationMs + shift >= Math.min(MIN_LAP_MS, before.durationMs) &&
    afterMs - shift >= Math.min(MIN_LAP_MS, afterMs);
  const beforeName = lapRunner(before).name;

  return (
    <div className="laps-press">
      <p className="laps-press__moment">
        Wissel gedrukt om {formatClockTimeMs(before.finishedAt)}
        {shiftMs !== 0 && <> → {formatClockTimeMs(before.finishedAt + shiftMs)}</>}
      </p>
      <div className="laps-press__bars" aria-hidden="true">
        <span style={{ flexGrow: before.durationMs + shiftMs }}>
          {beforeName}
          <small>{formatDurationMs(before.durationMs + shiftMs)}</small>
        </span>
        <span style={{ flexGrow: Math.max(afterMs - shiftMs, 0) }}>
          {nextRunner.name}
          <small>{after ? formatDurationMs(afterMs - shiftMs) : 'loopt nu'}</small>
        </span>
      </div>
      {hint && shiftMs !== hint.shiftMs && (
        <div className="laps-press__hint">
          <p>
            {beforeName} loopt meestal {formatTenths(hint.usualBeforeMs)}, {nextRunner.name} meestal{' '}
            {formatTenths(hint.usualAfterMs)}. Waarschijnlijk werd de spatie {shiftText(hint.shiftMs, true)} ingedrukt.
          </p>
          <button className="btn" onClick={() => setShiftMs(hint.shiftMs)}>
            Wissel {shiftText(hint.shiftMs, false)}
          </button>
        </div>
      )}
      <div className="laps-press__nudge" role="group" aria-label={`Ronde van ${beforeName}`}>
        <span>Ronde van {beforeName}</span>
        {NUDGES_MS.map((step) => (
          <button
            key={step}
            className="btn"
            disabled={!allowed(shiftMs + step)}
            onClick={() => setShiftMs((shift) => shift + step)}
          >
            {signedSeconds(step)}
          </button>
        ))}
      </div>
      <dl className="laps-press__result">
        <dt>{runnerText(lapRunner(before))}</dt>
        <dd>
          {shiftMs !== 0 && <s>{formatDurationMs(before.durationMs)}</s>}
          <strong>{formatDurationMs(before.durationMs + shiftMs)}</strong>
          {shiftMs !== 0 && <span>{signedSeconds(shiftMs)}</span>}
        </dd>
        <dt>{runnerText(nextRunner)}</dt>
        <dd>
          {after ? (
            <>
              {shiftMs !== 0 && <s>{formatDurationMs(after.durationMs)}</s>}
              <strong>{formatDurationMs(after.durationMs - shiftMs)}</strong>
            </>
          ) : (
            <strong>loopt nu</strong>
          )}
          {shiftMs !== 0 && <span>{signedSeconds(-shiftMs)}</span>}
        </dd>
      </dl>
      <div className="laps-press__actions">
        <button className="btn" disabled={shiftMs === 0} onClick={() => setShiftMs(0)}>
          Terugzetten
        </button>
        <button
          className="btn btn--primary"
          disabled={pending || shiftMs === 0}
          onClick={() => onMove(before.finishedAt + shiftMs)}
        >
          Wissel verschuiven
        </button>
      </div>
    </div>
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
  const matches = runners
    .filter((runner) => kind === 'split' || runner.id !== lap.runnerId)
    .filter((runner) => runnerMatchesSearch(runner, query));
  const candidates = matches
    .sort((a, b) => rank(suggestions, a.id) - rank(suggestions, b.id) || compareNumbers(a, b))
    .slice(0, PICKER_SIZE);
  const selected = runners.find((runner) => runner.id === selectedId) ?? null;
  // Like Loper zoeken in Wachtrij: Enter takes the one runner the search found, else the one selected.
  const enterRunner = query.trim() && matches.length === 1 ? matches[0] : selected;

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.repeat || event.nativeEvent.isComposing || !enterRunner) return;
    event.preventDefault();
    onPick(enterRunner);
  }

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
          onKeyDown={handleSearchKeyDown}
          placeholder="Zoek op nummer of naam"
          aria-label="Loper zoeken"
        />
        {enterRunner && (
          <p className="label-picker-help">
            {kind === 'move'
              ? `Enter: ronde naar ${runnerText(enterRunner)}.`
              : `Enter: tweede helft naar ${runnerText(enterRunner)}.`}
          </p>
        )}
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

/** "4 s te laat" or "4 s vroeger": how far a press is off, or where it moves. */
function shiftText(shiftMs: number, asMistake: boolean): string {
  const seconds = formatSeconds(shiftMs);
  if (asMistake) return shiftMs < 0 ? `${seconds} te laat` : `${seconds} te vroeg`;
  return shiftMs < 0 ? `${seconds} vroeger` : `${seconds} later`;
}

function signedSeconds(ms: number): string {
  return `${ms < 0 ? '−' : '+'}${formatSeconds(ms)}`;
}

function formatSeconds(ms: number, digits = 3): string {
  return `${(Math.abs(ms) / 1000).toLocaleString('nl-BE', { maximumFractionDigits: digits })} s`;
}

/** A usual lap time, to the tenth: "1:19.4". */
function formatTenths(ms: number): string {
  return formatDurationMs(Math.round(ms / 100) * 100).slice(0, -2);
}

function offUsualText(offMs: number): string {
  return `${formatSeconds(offMs, 1)} ${offMs > 0 ? 'trager' : 'sneller'} dan gewoonlijk`;
}

function runningRunner(race: RaceState, runners: readonly Runner[]): Runner | null {
  return runners.find((runner) => runner.id === race.activeRunnerId) ?? null;
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
    timeZone: 'Europe/Brussels',
  });
}
