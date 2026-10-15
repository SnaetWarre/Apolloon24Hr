import { LiveDot } from './LiveDot';
import React from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useAppData, useRaceHistory } from '../app/index';
import { buildKpis, isFastestLapForRecordMode, publicRecordModeTitle } from '../lib/analysis';
import { formatClockTimeMs, formatDurationMs, formatElapsedSeconds } from '../lib/time';
import { getNextWaitingRunner, lapRunnerLabel, runnerLabel } from '../lib/runners';
import { observeDisplayHistory } from '../lib/displayHistory';
import { useArrivals } from '../lib/motion';
import { buildRecentLapSummaries, buildRunnerRanking, collectRankingLabels, lapCoefficient } from '../lib/ranking';
import type { Label, LapRecord, LiveAppSnapshot, PublicRecordMode, RaceEvent, Runner } from '../types';
import { compareLabels, LabelBadge, labelKindOrder, labelKindTitle } from './LabelBadge';
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
                  <th scope="col">Coëf.</th>
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
                    <td className="recent-lap-coefficient">{formatCoefficient(lapCoefficient(lap))}</td>
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
  const { laps } = useRaceHistory({ scope: 'full' });
  const competitions = groupCompetitions(buildLabelStats(labels, runners, laps));
  const ranking = buildRunnerRanking(runners, laps, 'laps', null).slice(0, COMPETITION_RANKING_LENGTH);

  return (
    <main className={`display-root display-root--competitions display-root--${presentation}`}>
      <header className="inside-header">
        <DisplayBrand />
        <h1 className="competitions-title">Competities</h1>
        <DisplayTotals race={race} laps={laps} />
      </header>

      <div className="competitions-board">
        <div className="competitions-bands">
          {competitions.length ? (
            competitions.map((competition) => <CompetitionBand key={competition.kind} competition={competition} />)
          ) : (
            <div className="inside-empty">Nog geen labels met lopers. Geef lopers een label in Beheer › Labels.</div>
          )}
        </div>

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
        <PresentationSwitch presentation={presentation} onChange={setPresentation} />
      </footer>
    </main>
  );
}

type Competition = ReturnType<typeof groupCompetitions>[number];

/**
 * One competition as a scoreboard: every team's laps as a big figure, leader first,
 * and one strip below that splits all their laps by team, like a tug of war.
 */
function CompetitionBand({ competition }: { competition: Competition }) {
  const { stats } = competition;
  const leader = stats[0];
  const totalLaps = stats.reduce((total, stat) => total + stat.laps, 0);
  const leaderKey = `leader:${leader.label.id}`;
  // A new figure ticks; a new leader moves the whole scoreboard.
  const changed = useArrivals([leaderKey, ...stats.map((stat) => `${stat.label.id}:${stat.laps}`)]);

  return (
    <section
      className={`competition-band${stats.length === 2 ? ' is-duel' : ''}`}
      aria-label={competition.title}
      style={{ '--teams': stats.length } as React.CSSProperties}
    >
      <div className="competition-band__head">
        <h2>{competition.title}</h2>
        <p>{competitionVerdict(stats)}</p>
      </div>
      <ol key={leaderKey} className={`competition-scores${changed.has(leaderKey) ? ' display-rise' : ''}`}>
        {stats.map((stat) => (
          <li
            key={stat.label.id}
            className={stat.laps > 0 && stat.laps === leader.laps ? 'is-leading' : undefined}
            style={{ '--team': stat.label.color } as React.CSSProperties}
          >
            <span className="competition-team">
              {stat.label.imageUrl ? (
                <img src={stat.label.imageUrl} alt="" />
              ) : (
                <i className="competition-team__dot" aria-hidden="true" />
              )}
              <span>{stat.label.name}</span>
            </span>
            <strong
              key={stat.laps}
              className={
                changed.has(`${stat.label.id}:${stat.laps}`) ? 'competition-score value-tick' : 'competition-score'
              }
            >
              {stat.laps.toLocaleString('nl-BE')}
              <span className="visually-hidden"> rondes</span>
            </strong>
          </li>
        ))}
      </ol>
      <div className="competition-strip" aria-hidden="true">
        {totalLaps > 0 &&
          stats.map((stat) => (
            <span key={stat.label.id} style={{ flexGrow: stat.laps, background: stat.label.color }} />
          ))}
      </div>
    </section>
  );
}

function competitionVerdict(stats: Competition['stats']) {
  const [leader, second] = stats;
  if (leader.laps === 0) return 'Nog geen rondes';
  if (!second) return leader.laps === 1 ? '1 ronde' : `${leader.laps} rondes`;
  const tied = stats.filter((stat) => stat.laps === leader.laps);
  if (tied.length === stats.length && stats.length > 2) return 'Iedereen staat gelijk';
  if (tied.length === 2) return `${tied[0].label.name} en ${tied[1].label.name} staan gelijk`;
  if (tied.length > 2) return `${tied.length} ploegen staan gelijk`;
  const lead = leader.laps - second.laps;
  return `${leader.label.name} leidt met ${lead === 1 ? '1 ronde' : `${lead} rondes`}`;
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

/**
 * Displays keep their own presentation, independent of the operator theme.
 * Order: `?thema=licht|donker` in the URL, then the choice made on this display
 * (remembered by this browser), then the default for the screen.
 * A choice also goes into the URL: failover reopens the same address on another
 * laptop, whose browser storage is empty.
 */
function useDisplayPresentation(
  display: 'inside' | 'outside' | 'competitions',
  defaultPresentation: DisplayPresentation
): [DisplayPresentation, (next: DisplayPresentation) => void] {
  const storageKey = `apolloon.display.${display}`;
  const navigate = useNavigate();
  const searchString = useRouterState({ select: (state) => state.location.searchStr });
  const requested = new URLSearchParams(searchString).get('thema');
  const [stored, setStored] = React.useState<DisplayPresentation | null>(() => {
    try {
      const value = window.localStorage.getItem(storageKey);
      return value === 'light' || value === 'dark' ? value : null;
    } catch {
      return null;
    }
  });
  const choose = React.useCallback(
    (next: DisplayPresentation) => {
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // Keep the choice for this session only.
      }
      setStored(next);
      void navigate({
        to: '.',
        search: (previous: Record<string, unknown>) => ({ ...previous, thema: next === 'light' ? 'licht' : 'donker' }),
        replace: true,
      });
    },
    [navigate, storageKey]
  );
  const presentation =
    requested === 'licht' ? 'light' : requested === 'donker' ? 'dark' : (stored ?? defaultPresentation);
  React.useLayoutEffect(() => {
    document.documentElement.dataset.displayTone = presentation;
  }, [presentation]);
  return [presentation, choose];
}

function formatPoints(points: number) {
  return points.toLocaleString('nl-BE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function formatCoefficient(coefficient: number) {
  return coefficient.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function DisplayLabels({ labels }: { labels: Label[] }) {
  if (!labels.length) return null;
  return (
    <div className="display-labels">
      {labels.map((label) => (
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

function buildLabelStats(labels: Label[], runners: Runner[], laps: LapRecord[]) {
  const totals = new Map(labels.map((label) => [label.id, { label, runnerIds: new Set<string>(), laps: 0 }]));

  for (const runner of runners) {
    for (const label of runner.labels) {
      totals.get(label.id)?.runnerIds.add(runner.id);
    }
  }

  for (const lap of laps) {
    for (const label of lap.labels) {
      const total = totals.get(label.id);
      if (!total) continue;
      total.runnerIds.add(lap.runnerId);
      total.laps += 1;
    }
  }

  return [...totals.values()]
    .filter((total) => total.runnerIds.size > 0 || total.laps > 0)
    .map((total) => ({ label: total.label, runnerCount: total.runnerIds.size, laps: total.laps }))
    .sort((a, b) => compareLabels(a.label, b.label));
}

function groupCompetitions(stats: ReturnType<typeof buildLabelStats>) {
  const groups = new Map<string, typeof stats>();
  for (const stat of stats) {
    const kindTitle = labelKindTitle(stat.label.kind);
    groups.set(kindTitle, [...(groups.get(kindTitle) ?? []), stat]);
  }
  return [...groups.entries()]
    .map(([title, groupStats]) => ({
      kind: title,
      title,
      order: labelKindOrder(groupStats[0].label.kind),
      maxLaps: Math.max(0, ...groupStats.map((stat) => stat.laps)),
      // Within a competition the leader goes first.
      stats: [...groupStats].sort(
        (first, second) => second.laps - first.laps || first.label.name.localeCompare(second.label.name, 'nl-BE')
      ),
    }))
    .sort((first, second) => first.order - second.order);
}
