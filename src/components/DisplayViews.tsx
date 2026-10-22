import { LiveDot } from './LiveDot';
import React from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useAppData, useRaceHistory } from '../app/index';
import { buildKpis, isFastestLapForRecordMode, publicRecordModeTitle } from '../lib/analysis';
import { formatClockTimeMs, formatDurationMs, formatElapsedSeconds } from '../lib/time';
import { getNextWaitingRunner, lapRunnerLabel, runnerLabel } from '../lib/runners';
import { observeDisplayHistory } from '../lib/displayHistory';
import { useArrivals } from '../lib/motion';
import { lapPoints } from '../../shared/points';
import { buildRecentLapSummaries, buildRunnerRanking, collectRankingLabels } from '../lib/ranking';
import type { Label, LapRecord, LiveAppSnapshot, PublicRecordMode, RaceEvent, Runner } from '../types';
import { Icon } from './Icon';
import { compareLabels, LabelBadge, labelKindTitle } from './LabelBadge';
import { ModalDialog } from './ModalDialog';
import { LiveElapsed } from './LiveTime';

const OUTSIDE_ALERT_VISIBLE_MS = 8_000;
// The rows of both lists on the Binnenscherm, and the runners on the Competities screen.
const INSIDE_LIST_LENGTH = 25;
const COMPETITION_RANKING_LENGTH = 20;
const selectOutsideDisplayData = ({ runners, race, settings }: LiveAppSnapshot) => ({
  runners,
  race,
  settings,
});
const selectInsideDisplayData = ({ runners, labels, race }: LiveAppSnapshot) => ({ runners, labels, race });

export function OutsideDisplay() {
  const { runners, race, settings } = useAppData(selectOutsideDisplayData);
  const { laps, events, initialized: historyIsInitialized } = useRaceHistory({ scope: 'full' });
  const finished = Boolean(race.raceFinishedAt);
  const activeRunner = finished ? null : runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = finished ? null : getNextWaitingRunner(runners);
  const [recordLap, setRecordLap] = React.useState<LapRecord | null>(null);
  const [burgieEvent, setBurgieEvent] = React.useState<RaceEvent | null>(null);
  const knownLapIdsRef = React.useRef<Set<string> | null>(null);
  const knownEventIdsRef = React.useRef<Set<string> | null>(null);
  const recordTimeoutRef = React.useRef<number | null>(null);
  const burgieTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const latestLap = laps[0] || null;
    const lapHistoryObservation = observeDisplayHistory(
      historyIsInitialized,
      knownLapIdsRef.current,
      laps.map((lap) => lap.id),
      latestLap?.id || null
    );
    if (!lapHistoryObservation) return;
    knownLapIdsRef.current = lapHistoryObservation.knownIds;

    if (settings.publicRecordMode === 'off') {
      setRecordLap(null);
    }

    if (
      !burgieEvent &&
      latestLap &&
      lapHistoryObservation.shouldAnnounceLatest &&
      isFastestLapForRecordMode(latestLap, laps.slice(1), race, settings.publicRecordMode)
    ) {
      setRecordLap(latestLap);
      if (recordTimeoutRef.current !== null) {
        window.clearTimeout(recordTimeoutRef.current);
      }
      recordTimeoutRef.current = window.setTimeout(() => {
        setRecordLap(null);
        recordTimeoutRef.current = null;
      }, OUTSIDE_ALERT_VISIBLE_MS);
    }

    setRecordLap((currentRecordLap) => {
      if (!currentRecordLap) return currentRecordLap;
      return laps.some((lap) => lap.id === currentRecordLap.id) ? currentRecordLap : null;
    });
  }, [burgieEvent, historyIsInitialized, laps, race, settings.publicRecordMode]);

  React.useEffect(() => {
    const latestBurgieEvent = events.find((event) => event.type === 'burgie_gepakt') || null;
    const eventHistoryObservation = observeDisplayHistory(
      historyIsInitialized,
      knownEventIdsRef.current,
      events.map((event) => event.id),
      latestBurgieEvent?.id || null
    );
    if (!eventHistoryObservation) return;
    knownEventIdsRef.current = eventHistoryObservation.knownIds;

    if (latestBurgieEvent && eventHistoryObservation.shouldAnnounceLatest) {
      setRecordLap(null);
      if (recordTimeoutRef.current !== null) {
        window.clearTimeout(recordTimeoutRef.current);
        recordTimeoutRef.current = null;
      }
      setBurgieEvent(latestBurgieEvent);
      if (burgieTimeoutRef.current !== null) {
        window.clearTimeout(burgieTimeoutRef.current);
      }
      burgieTimeoutRef.current = window.setTimeout(() => {
        setBurgieEvent(null);
        burgieTimeoutRef.current = null;
      }, OUTSIDE_ALERT_VISIBLE_MS);
    }
  }, [events, historyIsInitialized]);

  React.useEffect(() => {
    return () => {
      if (recordTimeoutRef.current !== null) {
        window.clearTimeout(recordTimeoutRef.current);
      }
      if (burgieTimeoutRef.current !== null) {
        window.clearTimeout(burgieTimeoutRef.current);
      }
    };
  }, []);

  const [presentation] = useDisplayPresentation('outside', 'light');
  const activeKey = activeRunner?.id ?? 'none';
  const nextKey = nextRunner?.id ?? 'none';
  // A runner who takes over after the screen opened rises in; the first one is simply there.
  const changed = useArrivals([`active:${activeKey}`, `next:${nextKey}`]);

  return (
    <main className={`display-root display-root--outside display-root--${presentation}`}>
      <DisplayBrand />
      <section className="outside-band outside-band--current">
        {!finished && (
          <span className="display-kicker">
            <LiveDot />
            Nu op de piste
          </span>
        )}
        <div
          key={activeKey}
          className={`outside-runner${changed.has(`active:${activeKey}`) ? ' outside-runner--in' : ''}`}
        >
          {finished ? (
            <strong className="display-runner-name">Race afgelopen</strong>
          ) : (
            <DisplayRunner runner={activeRunner} empty={race.raceStartedAt ? 'Even niemand' : 'Nog niemand gestart'} />
          )}
        </div>
      </section>
      <section className="outside-band outside-band--next">
        {!finished && <span className="display-kicker">Volgende racer</span>}
        <div key={nextKey} className={`outside-runner${changed.has(`next:${nextKey}`) ? ' outside-runner--in' : ''}`}>
          <DisplayRunner
            runner={nextRunner}
            empty={finished ? 'Bedankt aan alle lopers' : 'Geen loper in de wachtrij'}
          />
        </div>
      </section>
      {burgieEvent ? (
        <OutsideBurgieFlash key={burgieEvent.id} event={burgieEvent} />
      ) : recordLap ? (
        <OutsideRecordFlash key={recordLap.id} lap={recordLap} mode={settings.publicRecordMode} />
      ) : null}
    </main>
  );
}

export function InsideDisplay() {
  const { runners, labels, race } = useAppData(selectInsideDisplayData);
  const [presentation, setPresentation] = useDisplayPresentation('inside', 'dark');
  const finished = Boolean(race.raceFinishedAt);
  const activeRunner = finished ? null : runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = finished ? null : getNextWaitingRunner(runners);
  const { laps, initialized: historyIsInitialized } = useRaceHistory({ scope: 'full' });
  const [rankingLabelId, setRankingLabelId] = React.useState<string | null>(null);
  const recentLapSummaries = buildRecentLapSummaries(laps, INSIDE_LIST_LENGTH);
  const rankingLabels = collectRankingLabels(labels, laps);
  const ranking = buildRunnerRanking(runners, laps, 'coefficient', rankingLabelId).slice(0, INSIDE_LIST_LENGTH);
  const rankingLabelName = rankingLabels.find((label) => label.id === rankingLabelId)?.name;
  const activeKey = activeRunner?.id ?? 'none';
  const nextKey = nextRunner?.id ?? 'none';
  const rankingKey = `ranking:${rankingLabelId ?? ''}`;
  // What changes after the screen opened moves: a handover, a lap that lands, another label.
  const changed = useArrivals([`active:${activeKey}`, `next:${nextKey}`, rankingKey]);
  const newLapIds = useArrivals(
    recentLapSummaries.map(({ lap }) => lap.id),
    historyIsInitialized
  );

  return (
    <main className={`display-root display-root--inside display-root--${presentation}`}>
      <header className="inside-header">
        <DisplayBrand />
        <h1 className="visually-hidden">24 urenloop, live standen</h1>
        <section className="inside-now" aria-label="Nu op de piste">
          <span className="inside-now__label">
            {!finished && <LiveDot />}
            {finished ? 'Race afgelopen' : 'Nu op de piste'}
          </span>
          <strong
            key={activeKey}
            className={`inside-now__runner${changed.has(`active:${activeKey}`) ? ' display-rise' : ''}`}
          >
            {activeRunner
              ? runnerLabel(activeRunner)
              : finished
                ? 'Bedankt aan alle lopers'
                : race.raceStartedAt
                  ? 'Even niemand'
                  : 'Nog niemand gestart'}
          </strong>
          {!finished && (
            <span className="inside-now__next">
              Volgende{' '}
              <strong key={nextKey} className={changed.has(`next:${nextKey}`) ? 'display-rise' : undefined}>
                {nextRunner ? runnerLabel(nextRunner) : 'niemand klaar'}
              </strong>
            </span>
          )}
        </section>
        <DisplayTotals race={race} laps={laps} />
      </header>

      <div className="inside-board">
        <section className="display-panel inside-list" aria-label={`Laatste ${INSIDE_LIST_LENGTH} lopers`}>
          <div className="inside-panel-heading">
            <h2>Laatste {INSIDE_LIST_LENGTH} lopers</h2>
          </div>
          {recentLapSummaries.length ? (
            <table className="display-table recent-lap-table">
              <thead>
                <tr>
                  <th scope="col">Binnen om</th>
                  <th scope="col">Loper</th>
                  <th scope="col">Deze ronde</th>
                  <th scope="col">Punten</th>
                  <th scope="col">Snelste</th>
                  <th scope="col">Gem.</th>
                </tr>
              </thead>
              <tbody>
                {recentLapSummaries.map(({ lap, bestLapMs, averageLapMs }, index) => (
                  <tr
                    key={lap.id}
                    className={`recent-lap-row${index === 0 ? ' is-latest' : ''}${newLapIds.has(lap.id) ? ' is-new' : ''}`}
                  >
                    <td className="recent-lap-when">
                      {index === 0 ? (
                        <span className="recent-lap-badge">Net binnen</span>
                      ) : (
                        formatDisplayClockTime(lap.finishedAt)
                      )}
                    </td>
                    <td className="recent-lap-runner">
                      {lapRunnerLabel(lap)}
                      <span className="recent-lap-number">ronde {lap.lapNumber}</span>
                    </td>
                    <td className="recent-lap-time recent-lap-time--current">{formatDurationMs(lap.durationMs)}</td>
                    <td className="recent-lap-points">{formatPoints(lapPoints(lap))}</td>
                    <td className="recent-lap-time">{formatDurationMs(bestLapMs)}</td>
                    <td className="recent-lap-time">{formatDurationMs(averageLapMs)}</td>
                  </tr>
                ))}
                <EmptyRows count={INSIDE_LIST_LENGTH - recentLapSummaries.length} columns={6} />
              </tbody>
            </table>
          ) : (
            <div className="inside-empty">De eerste rondes verschijnen hier zodra de timing start.</div>
          )}
        </section>

        <section className="display-panel inside-list" aria-label="Ranking op punten">
          <div className="inside-panel-heading">
            <h2>Ranking op punten</h2>
            <span>
              {rankingLabelName
                ? `Alleen ${rankingLabelName}`
                : 'Snelle rondes en rondes tussen middernacht en 16 uur tellen zwaarder'}
            </span>
          </div>
          {ranking.length ? (
            <table
              key={rankingKey}
              className={`display-table points-table${changed.has(rankingKey) ? ' display-rise' : ''}`}
            >
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">Plaats</span>
                  </th>
                  <th scope="col">Loper</th>
                  <th scope="col">Rondes</th>
                  <th scope="col">Punten</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((runner, index) => (
                  <tr key={runner.runnerId} className="points-row">
                    <td className="points-place">{index + 1}</td>
                    <td className="points-runner">{lapRunnerLabel(runner)}</td>
                    <td className="points-laps">{runner.lapCount}</td>
                    <td className="points-total">{formatPoints(runner.coefficientTotal)}</td>
                  </tr>
                ))}
                <EmptyRows count={INSIDE_LIST_LENGTH - ranking.length} columns={4} />
              </tbody>
            </table>
          ) : (
            <div className="inside-empty">Nog geen rondes voor deze selectie</div>
          )}
        </section>
      </div>

      <footer className="display-controls">
        <label className="ranking-label-filter">
          <span>Ranking voor</span>
          <select value={rankingLabelId ?? ''} onChange={(event) => setRankingLabelId(event.target.value || null)}>
            <option value="">Alle lopers</option>
            {rankingLabels.map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </select>
        </label>
        <PresentationSwitch presentation={presentation} onChange={setPresentation} />
      </footer>
    </main>
  );
}

export function CompetitionDisplay() {
  const { runners, labels, race } = useAppData(selectInsideDisplayData);
  const [presentation, setPresentation] = useDisplayPresentation('competitions', 'dark');
  const [competitions, setCompetitions] = useDisplayCompetitions(labels);
  const [picking, setPicking] = React.useState(false);
  const { laps } = useRaceHistory({ scope: 'full' });
  const lapsByLabel = countLapsByLabel(laps);
  const ranking = buildRunnerRanking(runners, laps, 'laps', null).slice(0, COMPETITION_RANKING_LENGTH);
  const canAdd = competitions.length < MAX_COMPETITIONS && labels.length >= 2;

  return (
    <main className={`display-root display-root--competitions display-root--${presentation}`}>
      <header className="inside-header">
        <DisplayBrand />
        <h1 className="competitions-title">Competities</h1>
        <DisplayTotals race={race} laps={laps} />
      </header>

      <div className="competitions-board">
        {competitions.length ? (
          <div
            className="competitions-list"
            // Each competition gets height for its teams plus its title.
            style={{ gridTemplateRows: competitions.map((teams) => `minmax(0, ${teams.length + 1.4}fr)`).join(' ') }}
          >
            {competitions.map((teams, index) => (
              <CompetitionBars
                key={competitionKey(teams)}
                teams={teams}
                lapsByLabel={lapsByLabel}
                onRemove={() => setCompetitions(competitions.filter((_, other) => other !== index))}
              />
            ))}
          </div>
        ) : (
          <div className="competitions-empty">
            <p>Kies welke ploegen tegen elkaar strijden, bijvoorbeeld 1ste, 2de en 3de jaar.</p>
            <button
              type="button"
              className="competitions-empty__add"
              onClick={() => setPicking(true)}
              disabled={!canAdd}
            >
              <Icon name="plus" size={20} />
              Competitie toevoegen
            </button>
            {labels.length < 2 && <p>Maak eerst minstens twee labels in Beheer › Labels.</p>}
          </div>
        )}

        <section className="display-panel laps-ranking" aria-label="Ranking op meeste rondes">
          <div className="inside-panel-heading">
            <h2>Meeste rondes</h2>
          </div>
          <p className="laps-ranking__help">Bij gelijke stand telt het snelste gemiddelde.</p>
          {ranking.length ? (
            <ol className="laps-ranking__list">
              {ranking.map((runner, index) => (
                <li key={runner.runnerId} className="laps-ranking__row">
                  <span>{index + 1}</span>
                  <strong>{lapRunnerLabel(runner)}</strong>
                  <em>
                    {runner.lapCount}
                    <small> gem. {formatDurationMs(runner.averageLapMs)}</small>
                  </em>
                </li>
              ))}
            </ol>
          ) : (
            <div className="inside-empty">Nog geen rondes.</div>
          )}
        </section>
      </div>

      <footer className="display-controls">
        {competitions.length > 0 && (
          <button
            type="button"
            className="inside-control-button"
            onClick={() => setPicking(true)}
            disabled={!canAdd}
            title={canAdd ? undefined : `Er passen ${MAX_COMPETITIONS} competities op dit scherm`}
          >
            Competitie toevoegen
          </button>
        )}
        <PresentationSwitch presentation={presentation} onChange={setPresentation} />
      </footer>

      {picking && (
        <CompetitionPicker
          labels={labels}
          taken={new Set(competitions.map(competitionKey))}
          onCancel={() => setPicking(false)}
          onAdd={(teams) => {
            setCompetitions([...competitions, teams]);
            setPicking(false);
          }}
        />
      )}
    </main>
  );
}

/**
 * One competition as a bar chart: a thick bar per team, leader on top, its laps at the
 * end of the bar and how far it trails the leader. A team that overtakes another
 * slides to its new place, so the room sees the overtake.
 */
function CompetitionBars({
  teams,
  lapsByLabel,
  onRemove,
}: {
  teams: Label[];
  lapsByLabel: Map<string, number>;
  onRemove: () => void;
}) {
  const standings = teams
    .map((label) => ({ label, laps: lapsByLabel.get(label.id) ?? 0 }))
    .sort((first, second) => second.laps - first.laps || first.label.name.localeCompare(second.label.name, 'nl-BE'));
  const leaderLaps = standings[0].laps;
  const title = teams.map((team) => team.name).join(' vs ');
  const changed = useArrivals(standings.map(({ label, laps }) => `${label.id}:${laps}`));
  const listRef = React.useRef<HTMLOListElement>(null);
  // Places, not pixels: a competition added or removed elsewhere resizes the rows,
  // and that must not look like an overtake.
  const rowPlaces = React.useRef(new Map<string, number>());
  React.useLayoutEffect(() => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-label-id]') ?? [];
    for (const [place, row] of rows.entries()) {
      const id = row.dataset.labelId ?? '';
      const last = rowPlaces.current.get(id);
      rowPlaces.current.set(id, place);
      if (last === undefined || last === place) continue;
      row.style.animation = 'none';
      void row.offsetHeight;
      row.style.setProperty('--slide-from', `${(last - place) * row.offsetHeight}px`);
      row.style.animation = 'slide-from var(--dur-3) var(--ease-out)';
    }
  });

  return (
    <section
      className="competition"
      aria-label={title}
      style={
        {
          '--teams': teams.length,
          // The bars leave room for the widest figure after them.
          '--digits': leaderLaps.toLocaleString('nl-BE').length,
        } as React.CSSProperties
      }
    >
      <div className="competition__head">
        <h2>{title}</h2>
        <p>{competitionVerdict(standings)}</p>
        <button type="button" className="competition__remove" onClick={onRemove} aria-label={`${title} verwijderen`}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <ol ref={listRef} className="competition__bars">
        {standings.map(({ label, laps }) => {
          const behind = leaderLaps - laps;
          return (
            <li
              key={label.id}
              data-label-id={label.id}
              className={`competition__row${laps > 0 && behind === 0 ? ' is-leading' : ''}`}
              style={{ '--team': label.color, '--share': leaderLaps ? laps / leaderLaps : 0 } as React.CSSProperties}
            >
              <span className="competition__team">
                {label.imageUrl ? (
                  <img src={label.imageUrl} alt="" />
                ) : (
                  <i className="competition__dot" aria-hidden="true" />
                )}
                <span>{label.name}</span>
              </span>
              <span className="competition__track">
                <i className="competition__bar" aria-hidden="true" />
                <strong
                  key={laps}
                  className={`competition__laps${changed.has(`${label.id}:${laps}`) ? ' value-tick' : ''}`}
                >
                  {laps.toLocaleString('nl-BE')}
                  <span className="visually-hidden"> rondes</span>
                </strong>
                {behind > 0 && (
                  <em className="competition__behind">
                    −{behind.toLocaleString('nl-BE')}
                    <span className="visually-hidden"> op de leider</span>
                  </em>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function competitionVerdict(standings: Array<{ label: Label; laps: number }>) {
  const [leader, second] = standings;
  if (leader.laps === 0) return 'Nog geen rondes';
  const tied = standings.filter((standing) => standing.laps === leader.laps);
  if (tied.length === standings.length) return 'Gelijke stand';
  if (tied.length > 1) return `${tied.map((standing) => standing.label.name).join(' en ')} staan gelijk`;
  const lead = leader.laps - second.laps;
  return `${leader.label.name} leidt met ${lead === 1 ? '1 ronde' : `${lead} rondes`}`;
}

/** Tick the teams of one competition, then add it. */
function CompetitionPicker({
  labels,
  taken,
  onCancel,
  onAdd,
}: {
  labels: Label[];
  /** Keys of the competitions already on the screen. */
  taken: Set<string>;
  onCancel: () => void;
  onAdd: (teams: Label[]) => void;
}) {
  const [picked, setPicked] = React.useState<string[]>([]);
  const sorted = [...labels].sort(compareLabels);
  const groups = new Map<string, Label[]>();
  for (const label of sorted) {
    const title = labelKindTitle(label.kind);
    groups.set(title, [...(groups.get(title) ?? []), label]);
  }
  const duplicate = taken.has(competitionKey(picked.map((id) => ({ id }))));
  const toggle = (id: string) =>
    setPicked((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));

  return (
    <ModalDialog label="Nieuwe competitie" onRequestClose={onCancel} closeOnBackdrop>
      <div className="competition-picker">
        <h2>Nieuwe competitie</h2>
        <p>Kies twee of meer ploegen die tegen elkaar strijden.</p>
        {[...groups.entries()].map(([title, groupLabels]) => (
          <div key={title} className="competition-picker__group" role="group" aria-label={title}>
            <h3>{title}</h3>
            <div className="competition-picker__choices">
              {groupLabels.map((label) => (
                <button
                  key={label.id}
                  type="button"
                  className="competition-picker__choice"
                  style={{ '--team': label.color } as React.CSSProperties}
                  aria-pressed={picked.includes(label.id)}
                  onClick={() => toggle(label.id)}
                >
                  {label.imageUrl ? (
                    <img src={label.imageUrl} alt="" />
                  ) : (
                    <i className="competition__dot" aria-hidden="true" />
                  )}
                  <span>{label.name}</span>
                  <Icon name="check" size={16} className="competition-picker__check" />
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="competition-picker__actions">
          <button type="button" className="inside-control-button" onClick={onCancel}>
            Annuleer
          </button>
          <button
            type="button"
            className="inside-control-button is-primary"
            disabled={picked.length < 2 || duplicate}
            onClick={() => onAdd(sorted.filter((label) => picked.includes(label.id)))}
          >
            {picked.length < 2
              ? 'Kies minstens 2 ploegen'
              : duplicate
                ? 'Deze competitie staat er al op'
                : `Toevoegen met ${picked.length} ploegen`}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

function countLapsByLabel(laps: LapRecord[]) {
  const counts = new Map<string, number>();
  for (const lap of laps) {
    for (const label of lap.labels) counts.set(label.id, (counts.get(label.id) ?? 0) + 1);
  }
  return counts;
}

/** Keeps a list at its full number of rows, so the rows of the two lists line up. */
function EmptyRows({ count, columns }: { count: number; columns: number }) {
  return Array.from({ length: Math.max(0, count) }, (_, index) => (
    <tr key={index} className="display-table__empty" aria-hidden="true">
      {Array.from({ length: columns }, (_, column) => (
        <td key={column}>{'\u00a0'}</td>
      ))}
    </tr>
  ));
}

function DisplayTotals({ race, laps }: { race: LiveAppSnapshot['race']; laps: LapRecord[] }) {
  // Same definition as Analyse, so the public and operator screens agree.
  const lapsPerHour = buildKpis(laps, race).lapsPerHour;
  const changed = useArrivals([`laps:${laps.length}`]);
  return (
    <dl className="inside-totals">
      <div>
        <dt>Racetijd</dt>
        <dd>
          {race.raceStartedAt ? (
            race.raceFinishedAt ? (
              formatElapsedSeconds(race.raceFinishedAt - race.raceStartedAt)
            ) : (
              <LiveElapsed startedAt={race.raceStartedAt} />
            )
          ) : (
            '0:00'
          )}
        </dd>
      </div>
      <div>
        <dt>Rondes</dt>
        <dd key={laps.length} className={changed.has(`laps:${laps.length}`) ? 'value-tick' : undefined}>
          {laps.length.toLocaleString('nl-BE')}
        </dd>
      </div>
      <div>
        <dt>Per uur</dt>
        <dd>
          {lapsPerHour == null
            ? '—'
            : lapsPerHour.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
        </dd>
      </div>
    </dl>
  );
}

function PresentationSwitch({
  presentation,
  onChange,
}: {
  presentation: DisplayPresentation;
  onChange: (next: DisplayPresentation) => void;
}) {
  return (
    <div className="inside-presentation" role="group" aria-label="Weergave van dit scherm">
      <button
        className={`inside-control-button${presentation === 'light' ? ' is-active' : ''}`}
        aria-pressed={presentation === 'light'}
        onClick={() => onChange('light')}
      >
        Licht
      </button>
      <button
        className={`inside-control-button${presentation === 'dark' ? ' is-active' : ''}`}
        aria-pressed={presentation === 'dark'}
        onClick={() => onChange('dark')}
      >
        Donker
      </button>
    </div>
  );
}

type DisplayPresentation = 'light' | 'dark';
type DisplayName = 'inside' | 'outside' | 'competitions';

/**
 * Displays keep their own presentation, independent of the operator theme.
 * `?thema=licht|donker` in the address, then the choice made on this display,
 * then the default for the screen.
 */
function useDisplayPresentation(
  display: DisplayName,
  defaultPresentation: DisplayPresentation
): [DisplayPresentation, (next: DisplayPresentation) => void] {
  const [value, setValue] = useDisplaySetting(display, 'thema');
  // Older versions stored 'light' and 'dark'.
  const presentation =
    value === 'licht' || value === 'light'
      ? 'light'
      : value === 'donker' || value === 'dark'
        ? 'dark'
        : defaultPresentation;
  React.useLayoutEffect(() => {
    document.documentElement.dataset.displayTone = presentation;
  }, [presentation]);
  return [presentation, (next) => setValue(next === 'light' ? 'licht' : 'donker')];
}

const MAX_COMPETITIONS = 6;

/** The same teams give the same key, whatever order they were picked in. */
function competitionKey(teams: Array<{ id: string }>) {
  return teams
    .map((team) => team.id)
    .sort()
    .join('.');
}

/**
 * The competitions on the Competitiescherm, as `?competities=id.id.id,id.id`.
 * A label that was deleted drops out, and so does a competition left with one team.
 */
function useDisplayCompetitions(labels: Label[]): [Label[][], (next: Label[][]) => void] {
  const [value, setValue] = useDisplaySetting('competitions', 'competities');
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const competitions = (value ?? '')
    .split(',')
    .map((competition) => [...new Set(competition.split('.').flatMap((id) => labelsById.get(id) ?? []))])
    .filter((teams) => teams.length >= 2)
    .filter((teams, index, all) => all.findIndex((other) => competitionKey(other) === competitionKey(teams)) === index)
    .slice(0, MAX_COMPETITIONS);
  return [
    competitions,
    (next) => setValue(next.length ? next.map((teams) => teams.map((team) => team.id).join('.')).join(',') : null),
  ];
}

/**
 * A choice made on one display. The address wins, then what this browser remembers.
 * The choice always goes into the address too: failover reopens the same address
 * on another laptop, whose browser storage is empty.
 */
function useDisplaySetting(display: DisplayName, param: string): [string | null, (next: string | null) => void] {
  const storageKey = param === 'thema' ? `apolloon.display.${display}` : `apolloon.display.${display}.${param}`;
  const navigate = useNavigate();
  const searchString = useRouterState({ select: (state) => state.location.searchStr });
  const requested = new URLSearchParams(searchString).get(param);
  const [stored, setStored] = React.useState<string | null>(() => {
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const writeAddress = React.useCallback(
    (next: string | null) =>
      void navigate({
        to: '.',
        search: (previous: Record<string, unknown>) => ({ ...previous, [param]: next ?? undefined }),
        replace: true,
      }),
    [navigate, param]
  );
  const choose = React.useCallback(
    (next: string | null) => {
      try {
        if (next === null) window.localStorage.removeItem(storageKey);
        else window.localStorage.setItem(storageKey, next);
      } catch {
        // Keep the choice for this session only.
      }
      setStored(next);
      writeAddress(next);
    },
    [storageKey, writeAddress]
  );
  React.useEffect(() => {
    if (requested === null && stored !== null) writeAddress(stored);
  }, [requested, stored, writeAddress]);
  return [requested ?? stored, choose];
}

function formatPoints(points: number) {
  return points.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatDisplayClockTime(finishedAt: number) {
  return formatClockTimeMs(finishedAt).split('.')[0];
}

function DisplayBrand() {
  const navigate = useNavigate();
  return (
    <div className="display-brand">
      <button
        type="button"
        className="display-brand__home"
        onClick={() => void navigate({ to: '/' })}
        aria-label="Apolloon, terug naar start"
        title="Terug naar start"
      >
        <span className="brand-mark" aria-hidden="true" />
      </button>
      <span>you&apos;ll never walk alone</span>
    </div>
  );
}

// Steps a long name down until every word fits on a line and the name fits in two lines.
// "Marie-Christine Van den Broeck-Vandevelde" was cut to "Van den…" at full size.
const RUNNER_NAME_SCALES = [1, 0.85, 0.68, 0.6, 0.5];

function DisplayRunner({ runner, empty }: { runner: Runner | null; empty: string }) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const name = runner?.name;
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    const nameNode = row?.querySelector<HTMLElement>('.display-runner-name');
    if (!row || !nameNode) return;
    const fit = () => {
      // Without breaking inside words, a word that is too wide shows up as horizontal overflow.
      nameNode.style.overflowWrap = 'normal';
      for (const scale of RUNNER_NAME_SCALES) {
        row.style.setProperty('--runner-name-scale', String(scale));
        const lineHeight = parseFloat(getComputedStyle(nameNode).fontSize);
        const hiddenHeight = nameNode.scrollHeight - nameNode.clientHeight;
        if (nameNode.scrollWidth <= nameNode.clientWidth && hiddenHeight < lineHeight / 2) break;
      }
      nameNode.style.overflowWrap = '';
    };
    fit();
    let mounted = true;
    // Geist swaps in after the first paint and is wider than the fallback font.
    void document.fonts.ready.then(() => mounted && fit());
    window.addEventListener('resize', fit);
    return () => {
      mounted = false;
      window.removeEventListener('resize', fit);
    };
  }, [name]);
  if (!runner) return <strong className="display-runner-name display-runner-name--empty">{empty}</strong>;
  return (
    <>
      <div ref={rowRef} className="display-runner">
        {runner.runnerNumber && <span className="display-bib">{runner.runnerNumber}</span>}
        <strong className="display-runner-name">{runner.name}</strong>
      </div>
      <DisplayLabels labels={runner.labels} />
    </>
  );
}

// Only zusterverenigingen show outside; other labels (like speedteams) stay private.
function DisplayLabels({ labels }: { labels: Label[] }) {
  const shown = labels.filter((label) => label.kind === 'zustervereniging' || label.kind === 'association');
  if (!shown.length) return null;
  return (
    <div className="display-labels">
      {shown.map((label) => (
        <LabelBadge key={label.id} label={label} />
      ))}
    </div>
  );
}

// The flash fades in, holds, and fades out just before it is removed.
const flashStyle = { '--flash-ms': `${OUTSIDE_ALERT_VISIBLE_MS}ms` } as React.CSSProperties;
// Longer titles get a smaller size so they stay on two lines.
const LONG_FLASH_TITLE = 18;

function OutsideRecordFlash({ lap, mode }: { lap: LapRecord; mode: PublicRecordMode }) {
  return (
    <section className="outside-record-flash" style={flashStyle} aria-live="polite">
      <div
        className={`record-flash-content${publicRecordModeTitle(mode).length > LONG_FLASH_TITLE ? ' record-flash-content--long' : ''}`}
      >
        <span>{publicRecordModeTitle(mode)}</span>
        <strong>{formatDurationMs(lap.durationMs)}</strong>
        <em>{lapRunnerLabel(lap)}</em>
      </div>
    </section>
  );
}

function OutsideBurgieFlash({ event }: { event: RaceEvent }) {
  return (
    <section className="outside-record-flash" style={flashStyle} aria-live="polite">
      <div className="record-flash-content">
        <span>Burgie gepakt</span>
        <strong>ZINGEN</strong>
        <em>{eventRunnerLabel(event)}</em>
      </div>
    </section>
  );
}

function eventRunnerLabel(event: RaceEvent) {
  if (!event.runnerName) return 'Publiek moment';
  return lapRunnerLabel({ runnerNumber: event.runnerNumber, runnerName: event.runnerName });
}
