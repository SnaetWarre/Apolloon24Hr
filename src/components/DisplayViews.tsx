import { LiveDot } from './LiveDot';
import React from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useAppData, useRaceHistory } from '../app/index';
import { buildKpis, isFastestLapForRecordMode, publicRecordModeTitle } from '../lib/analysis';
import { formatClockTimeMs, formatDurationMs, formatElapsedSeconds } from '../lib/time';
import { getNextWaitingRunner, lapRunnerLabel, runnerLabel } from '../lib/runners';
import { observeDisplayHistory } from '../lib/displayHistory';
import { useArrivals } from '../lib/motion';
import { buildRecentLapSummaries, buildRunnerRanking, collectRankingLabels, type RankingMode } from '../lib/ranking';
import type { Label, LapRecord, LiveAppSnapshot, PublicRecordMode, RaceEvent, Runner } from '../types';
import { compareLabels, LabelBadge, labelKindOrder, labelKindTitle } from './LabelBadge';
import { LiveDuration, LiveElapsed } from './LiveTime';

const OUTSIDE_ALERT_VISIBLE_MS = 8_000;
const INSIDE_RANKING_ROTATION_MS = 15_000;
const selectOutsideDisplayData = ({ runners, race, settings }: LiveAppSnapshot) => ({
  runners,
  race,
  settings,
});
const selectInsideDisplayData = ({ runners, labels, race }: LiveAppSnapshot) => ({ runners, labels, race });

export function OutsideDisplay() {
  const { runners, race, settings } = useAppData(selectOutsideDisplayData);
  const { laps, events, initialized: historyIsInitialized } = useRaceHistory({ scope: 'full' });
  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);
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
        <span className="display-kicker">
          <LiveDot />
          Nu op de piste
        </span>
        <div
          key={activeKey}
          className={`outside-runner${changed.has(`active:${activeKey}`) ? ' outside-runner--in' : ''}`}
        >
          <DisplayRunner runner={activeRunner} empty="Nog niemand gestart" />
        </div>
      </section>
      <section className="outside-band outside-band--next">
        <span className="display-kicker">Volgende loper</span>
        <div key={nextKey} className={`outside-runner${changed.has(`next:${nextKey}`) ? ' outside-runner--in' : ''}`}>
          <DisplayRunner runner={nextRunner} empty="Geen loper in de wachtrij" />
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
  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);
  const { laps, initialized: historyIsInitialized } = useRaceHistory({ scope: 'full' });
  const [rankingMode, setRankingMode] = React.useState<RankingMode>('laps');
  const [rankingLabelId, setRankingLabelId] = React.useState<string | null>(null);
  const [rotationPaused, setRotationPaused] = React.useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(false);
  const recentLapSummaries = buildRecentLapSummaries(laps);
  const rankingLabels = collectRankingLabels(labels, laps);
  const ranking = buildRunnerRanking(runners, laps, rankingMode, rankingLabelId).slice(0, 10);
  const competitions = groupCompetitions(buildLabelStats(labels, runners, laps));

  React.useEffect(() => {
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateReducedMotionPreference = () => setPrefersReducedMotion(reducedMotionQuery.matches);
    updateReducedMotionPreference();
    reducedMotionQuery.addEventListener('change', updateReducedMotionPreference);
    return () => reducedMotionQuery.removeEventListener('change', updateReducedMotionPreference);
  }, []);

  React.useEffect(() => {
    if (prefersReducedMotion || rotationPaused) return;
    const rotationTimeout = window.setTimeout(() => {
      setRankingMode((currentMode) => (currentMode === 'laps' ? 'coefficient' : 'laps'));
    }, INSIDE_RANKING_ROTATION_MS);
    return () => window.clearTimeout(rotationTimeout);
  }, [prefersReducedMotion, rankingMode, rotationPaused]);

  const rotationActive = !prefersReducedMotion && !rotationPaused;
  const competitionRowCount = competitions.reduce((total, competition) => total + competition.stats.length, 0);
  // Same definition as Analyse, so the public and operator screens agree.
  const lapsPerHour = buildKpis(laps, race).lapsPerHour;
  const activeKey = activeRunner?.id ?? 'none';
  const nextKey = nextRunner?.id ?? 'none';
  // What changes after the screen opened moves: a handover, a lap that lands, a ranking that switches.
  const changed = useArrivals([
    `active:${activeKey}`,
    `next:${nextKey}`,
    `laps:${laps.length}`,
    `ranking:${rankingMode}:${rankingLabelId ?? ''}`,
  ]);
  const newLapIds = useArrivals(
    recentLapSummaries.map(({ lap }) => lap.id),
    historyIsInitialized
  );
  const rankingKey = `ranking:${rankingMode}:${rankingLabelId ?? ''}`;

  return (
    <main className={`display-root display-root--inside display-root--${presentation}`}>
      <header className="inside-header">
        <DisplayBrand />
        <h1 className="visually-hidden">24 urenloop, live standen</h1>
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
      </header>

      <div className="inside-live">
        <section className="inside-now" aria-label="Nu op de piste">
          <span className="inside-now__label">
            <LiveDot />
            Nu op de piste
          </span>
          <strong
            key={activeKey}
            className={`inside-now__runner${changed.has(`active:${activeKey}`) ? ' display-rise' : ''}`}
          >
            {activeRunner ? runnerLabel(activeRunner) : 'Nog niemand gestart'}
          </strong>
          {activeRunner && race.activeStartedAt && (
            <LiveDuration
              startedAt={race.activeStartedAt}
              className="inside-now__time"
              refreshMs={1_000}
              format="seconds"
            />
          )}
          <span className="inside-now__next">
            Volgende:{' '}
            <strong key={nextKey} className={changed.has(`next:${nextKey}`) ? 'display-rise' : undefined}>
              {nextRunner ? runnerLabel(nextRunner) : 'niemand klaar'}
            </strong>
          </span>
        </section>
        <section className="inside-recent-laps" aria-label="Laatste 3 lopers">
          <h2 className="visually-hidden">Laatste 3 lopers</h2>
          {recentLapSummaries.length ? (
            recentLapSummaries.map(({ lap, bestLapMs, averageLapMs }, index) => (
              <article
                key={lap.id}
                className={`recent-lap-row${index === 0 ? ' is-latest' : ''}${newLapIds.has(lap.id) ? ' is-new' : ''}`}
              >
                <span className="recent-lap-card-header">
                  {index === 0 ? 'Net binnen' : `Binnen om ${formatDisplayClockTime(lap.finishedAt)}`}, ronde{' '}
                  {lap.lapNumber}
                </span>
                <strong className="recent-lap-runner">{lapRunnerLabel(lap)}</strong>
                <div className="recent-lap-times">
                  <div className="recent-lap-time recent-lap-time--current">
                    <span>Deze ronde</span>
                    <strong>{formatDurationMs(lap.durationMs)}</strong>
                  </div>
                  <div className="recent-lap-time">
                    <span>Snelste ronde</span>
                    <strong>{formatDurationMs(bestLapMs)}</strong>
                  </div>
                  <div className="recent-lap-time">
                    <span>Gem. ronde</span>
                    <strong>{formatDurationMs(averageLapMs)}</strong>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="inside-empty">De eerste rondes verschijnen hier zodra de timing start.</div>
          )}
        </section>
      </div>

      <div className="inside-board">
        <section className="display-panel inside-ranking-panel">
          <div className="inside-panel-heading">
            <h2>Ranking</h2>
            <div className="inside-ranking-modes" role="group" aria-label="Rangschikking op basis van">
              <button
                className={rankingMode === 'laps' ? 'is-active' : ''}
                onClick={() => setRankingMode('laps')}
                aria-pressed={rankingMode === 'laps'}
              >
                Meeste rondes
              </button>
              <button
                className={rankingMode === 'coefficient' ? 'is-active' : ''}
                onClick={() => setRankingMode('coefficient')}
                aria-pressed={rankingMode === 'coefficient'}
              >
                Punten
              </button>
            </div>
          </div>
          <div className="inside-ranking-rotation" aria-hidden="true">
            {rotationActive && <i key={rankingMode} style={{ animationDuration: `${INSIDE_RANKING_ROTATION_MS}ms` }} />}
          </div>
          <p className="inside-ranking-modes-help">
            {rankingMode === 'coefficient'
              ? 'Punten: snellere rondes scoren hoger; het tijdvak van aankomst telt mee.'
              : 'Meeste rondes; bij gelijke stand telt het snelste gemiddelde.'}
            {rankingLabelId ? ` Label: ${rankingLabels.find((label) => label.id === rankingLabelId)?.name ?? ''}.` : ''}
          </p>
          <ol key={rankingKey} className={`ranking-list${changed.has(rankingKey) ? ' display-rise' : ''}`}>
            {ranking.map((runner, index) => (
              <li key={runner.runnerId} className="ranking-row">
                <span>{index + 1}</span>
                <strong>{lapRunnerLabel(runner)}</strong>
                <em>
                  {rankingMode === 'coefficient'
                    ? `${formatCoefficient(runner.coefficientTotal)} ptn · ${runner.lapCount} rondes`
                    : `${runner.lapCount} rondes · gem. ${formatDurationMs(runner.averageLapMs)}`}
                </em>
              </li>
            ))}
            {!ranking.length && <li className="inside-empty">Nog geen rondes voor deze selectie</li>}
          </ol>
          <div className="inside-controls">
            <label className="ranking-label-filter">
              <span>Label</span>
              <select value={rankingLabelId ?? ''} onChange={(event) => setRankingLabelId(event.target.value || null)}>
                <option value="">Alle labels</option>
                {rankingLabels.map((label) => (
                  <option key={label.id} value={label.id}>
                    {label.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inside-presentation" role="group" aria-label="Weergave van dit scherm">
              <button
                className={`inside-control-button${presentation === 'light' ? ' is-active' : ''}`}
                aria-pressed={presentation === 'light'}
                onClick={() => setPresentation('light')}
              >
                Licht
              </button>
              <button
                className={`inside-control-button${presentation === 'dark' ? ' is-active' : ''}`}
                aria-pressed={presentation === 'dark'}
                onClick={() => setPresentation('dark')}
              >
                Donker
              </button>
            </div>
            <p className="inside-ranking-rotation-note">
              {prefersReducedMotion
                ? 'Automatisch wisselen is uitgeschakeld'
                : rotationPaused
                  ? 'Automatisch wisselen is gepauzeerd'
                  : 'Wisselt automatisch om de 15 seconden'}
            </p>
            {!prefersReducedMotion && (
              <button
                className="inside-control-button"
                aria-pressed={rotationPaused}
                onClick={() => setRotationPaused((paused) => !paused)}
              >
                {rotationPaused ? 'Hervat wisselen' : 'Pauzeer wisselen'}
              </button>
            )}
          </div>
        </section>
        <section className="display-panel inside-competitions">
          <div className="inside-panel-heading">
            <h2>Competities</h2>
            <span>rondes van doel</span>
          </div>
          {competitions.length ? (
            <div className={`competition-list${competitionRowCount > 9 ? ' is-dense' : ''}`}>
              {competitions.map((competition) => (
                <div key={competition.kind} className="competition">
                  <h3>{competition.title}</h3>
                  {competition.stats.map((stat, index) => (
                    <div
                      key={stat.label.id}
                      className={`progress-item${index === 0 && stat.laps > 0 ? ' is-leading' : ''}`}
                    >
                      <LabelBadge label={stat.label} />
                      <div className="progress-track">
                        <span
                          title={stat.target > 0 ? `${stat.laps} van ${stat.target} rondes` : `${stat.laps} rondes`}
                          style={
                            {
                              '--progress': `${stat.target > 0 ? Math.min(100, stat.percent) : competition.maxLaps > 0 ? (stat.laps / competition.maxLaps) * 100 : 0}%`,
                              background: stat.label.color,
                            } as React.CSSProperties
                          }
                        />
                      </div>
                      <em>{stat.target > 0 ? `${stat.laps} / ${stat.target}` : `${stat.laps} rondes`}</em>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="inside-empty">Nog geen labels met lopers.</div>
          )}
        </section>
      </div>
    </main>
  );
}

type DisplayPresentation = 'light' | 'dark';

/**
 * Displays keep their own presentation, independent of the operator theme.
 * Order: `?thema=licht|donker` in the URL, then the choice made on this display
 * (remembered by this browser), then the default for the screen.
 */
function useDisplayPresentation(
  display: 'inside' | 'outside',
  defaultPresentation: DisplayPresentation
): [DisplayPresentation, (next: DisplayPresentation) => void] {
  const storageKey = `apolloon.display.${display}`;
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
    },
    [storageKey]
  );
  const presentation =
    requested === 'licht' ? 'light' : requested === 'donker' ? 'dark' : (stored ?? defaultPresentation);
  React.useLayoutEffect(() => {
    document.documentElement.dataset.displayTone = presentation;
  }, [presentation]);
  return [presentation, choose];
}

function formatCoefficient(coefficient: number) {
  return coefficient.toLocaleString('nl-BE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
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

function DisplayRunner({ runner, empty }: { runner: Runner | null; empty: string }) {
  if (!runner) return <strong className="display-runner-name display-runner-name--empty">{empty}</strong>;
  return (
    <>
      <div className="display-runner">
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
  const totals = new Map(
    labels.map((label) => [label.id, { label, runnerIds: new Set<string>(), laps: 0, calculatedTarget: 0 }])
  );

  for (const runner of runners) {
    for (const label of runner.labels) {
      const total = totals.get(label.id);
      if (!total) continue;
      total.runnerIds.add(runner.id);
      total.calculatedTarget += runner.targetLaps || 0;
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
    .map((total) => {
      const target = total.label.targetLaps ?? total.calculatedTarget;
      return {
        label: total.label,
        runnerCount: total.runnerIds.size,
        laps: total.laps,
        target,
        percent: target > 0 ? (total.laps / target) * 100 : 0,
      };
    })
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
      // Within a competition the leader goes first: progress towards target, otherwise laps.
      stats: [...groupStats].sort(
        (first, second) =>
          (second.target > 0 && first.target > 0 ? second.percent - first.percent : 0) ||
          second.laps - first.laps ||
          first.label.name.localeCompare(second.label.name, 'nl-BE')
      ),
    }))
    .sort((first, second) => first.order - second.order);
}
