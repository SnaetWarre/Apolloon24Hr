import React from 'react';
import { useAppData, useRaceHistory } from '../app/index';
import { isFastestLapForRecordMode, publicRecordModeTitle } from '../lib/analysis';
import { formatClockTimeMs, formatDurationMs } from '../lib/time';
import { getNextWaitingRunner, lapRunnerLabel, runnerLabel } from '../lib/runners';
import { observeDisplayHistory } from '../lib/displayHistory';
import {
  buildRecentLapSummaries,
  buildRunnerRanking,
  collectRankingLabels,
  type RankingMode,
} from '../lib/ranking';
import type { Label, LapRecord, LiveAppSnapshot, PublicRecordMode, RaceEvent, Runner } from '../types';
import { LabelBadge } from './LabelBadge';

const OUTSIDE_ALERT_VISIBLE_MS = 8_000;
const INSIDE_RANKING_ROTATION_MS = 15_000;
const selectOutsideDisplayData = ({ runners, race, settings }: LiveAppSnapshot) => ({
  runners,
  race,
  settings,
});
const selectInsideDisplayData = ({ runners, labels }: LiveAppSnapshot) => ({ runners, labels });

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

  return (
    <main className="display-root display-root--outside">
      <section className="outside-band outside-band--current">
        <DisplayBrand tone="light" />
        <div className="outside-runner">
          <span className="display-kicker">Nu op de piste</span>
          <strong className="display-runner-name">
            {activeRunner ? runnerLabel(activeRunner) : 'Nog niemand gestart'}
          </strong>
          {activeRunner && <DisplayLabels labels={activeRunner.labels} />}
        </div>
      </section>
      <section className="outside-band outside-band--next">
        <div className="outside-runner outside-runner--next">
          <span className="display-kicker">Volgende racer</span>
          <strong className="display-runner-name">
            {nextRunner ? runnerLabel(nextRunner) : 'Geen loper in wachtrij'}
          </strong>
          {nextRunner && <DisplayLabels labels={nextRunner.labels} />}
        </div>
      </section>
      {burgieEvent ? (
        <OutsideBurgieFlash event={burgieEvent} />
      ) : recordLap ? (
        <OutsideRecordFlash lap={recordLap} mode={settings.publicRecordMode} />
      ) : null}
    </main>
  );
}

export function InsideDisplay() {
  const { runners, labels } = useAppData(selectInsideDisplayData);
  const { laps } = useRaceHistory({ scope: 'full' });
  const [rankingMode, setRankingMode] = React.useState<RankingMode>('laps');
  const [rankingLabelId, setRankingLabelId] = React.useState<string | null>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(false);
  const recentLapSummaries = React.useMemo(() => buildRecentLapSummaries(laps), [laps]);
  const rankingLabels = React.useMemo(() => collectRankingLabels(labels, laps), [labels, laps]);
  const ranking = React.useMemo(
    () => buildRunnerRanking(runners, laps, rankingMode, rankingLabelId).slice(0, 10),
    [laps, rankingLabelId, rankingMode, runners]
  );
  const labelStats = React.useMemo(
    () => buildLabelStats(labels, runners, laps),
    [labels, laps, runners]
  );

  React.useEffect(() => {
    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateReducedMotionPreference = () => setPrefersReducedMotion(reducedMotionQuery.matches);
    updateReducedMotionPreference();
    reducedMotionQuery.addEventListener('change', updateReducedMotionPreference);
    return () => reducedMotionQuery.removeEventListener('change', updateReducedMotionPreference);
  }, []);

  React.useEffect(() => {
    if (prefersReducedMotion) return;
    const rotationTimeout = window.setTimeout(() => {
      setRankingMode((currentMode) => currentMode === 'laps' ? 'coefficient' : 'laps');
    }, INSIDE_RANKING_ROTATION_MS);
    return () => window.clearTimeout(rotationTimeout);
  }, [prefersReducedMotion, rankingMode]);

  return (
    <main className="display-root display-root--inside">
      <header className="inside-header">
        <DisplayBrand tone="light" />
        <div>
          <h1>Live standen</h1>
          <span>{laps.length} rondes geregistreerd</span>
        </div>
      </header>
      <div className="inside-grid">
        <section className="display-panel inside-recent-laps">
          <h2>Laatste 3 lopers</h2>
          {recentLapSummaries.length ? (
            <div className="recent-lap-list">
              {recentLapSummaries.map(({ lap, bestLapMs, averageLapMs }, index) => (
                <article key={lap.id} className={`recent-lap-row${index === 0 ? ' is-latest' : ''}`}>
                  <div className="recent-lap-card-header">
                    <span>{index === 0 ? 'Net binnen' : `Binnen om ${formatDisplayClockTime(lap.finishedAt)}`}</span>
                    <span>Ronde {lap.lapNumber} van deze loper</span>
                  </div>
                  <div className="recent-lap-runner">
                    <strong>{lapRunnerLabel(lap)}</strong>
                    <DisplayLabels labels={lap.labels} />
                  </div>
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
              ))}
            </div>
          ) : (
            <div className="empty-inline">Nog geen rondes geregistreerd</div>
          )}
        </section>
        <section className="display-panel inside-ranking-panel">
          <div className="inside-panel-heading">
            <h2>Ranking</h2>
            <label className="ranking-label-filter">
              <span>Filter</span>
              <select
                value={rankingLabelId ?? ''}
                onChange={(event) => setRankingLabelId(event.target.value || null)}
              >
                <option value="">Alle labels</option>
                {rankingLabels.map((label) => (
                  <option key={label.id} value={label.id}>{label.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="inside-ranking-modes" aria-label="Rangschikking op basis van">
            <button
              className={rankingMode === 'laps' ? 'is-active' : ''}
              onClick={() => setRankingMode('laps')}
              aria-pressed={rankingMode === 'laps'}
            >
              Aantal toeren
            </button>
            <button
              className={rankingMode === 'coefficient' ? 'is-active' : ''}
              onClick={() => setRankingMode('coefficient')}
              aria-pressed={rankingMode === 'coefficient'}
            >
              Coëfficiëntensom
            </button>
          </div>
          <p className="inside-ranking-rotation-note">
            {prefersReducedMotion
              ? 'Automatisch wisselen is uitgeschakeld'
              : 'Wisselt automatisch om de 15 seconden'}
          </p>
          <div className="ranking-list">
            {ranking.map((runner, index) => (
              <div key={runner.runnerId} className="ranking-row">
                <span>{index + 1}</span>
                <strong>{rankingRunnerLabel(runner)}</strong>
                <em>
                  {rankingMode === 'coefficient'
                    ? `${formatCoefficient(runner.coefficientTotal)} punten`
                    : `${runner.lapCount} toeren`}
                </em>
              </div>
            ))}
            {!ranking.length && <div className="empty-inline">Nog geen rondes voor deze selectie</div>}
          </div>
        </section>
        <section className="display-panel">
          <h2>Progressie per label</h2>
          <div className="progress-list">
            {labelStats.map((stat) => (
              <div key={stat.label.id} className="progress-item">
                <div>
                  <strong>
                    <LabelBadge label={stat.label} />
                  </strong>
                  <span>
                    {stat.laps} toeren
                    {stat.target > 0 ? ` / doel ${stat.target}` : ''}
                  </span>
                </div>
                <div className="progress-track">
                  <span
                    style={{
                      width: `${Math.min(100, stat.percent)}%`,
                      background: stat.label.color,
                    }}
                  />
                </div>
                <em>{stat.target > 0 ? `${Math.round(stat.percent)}%` : `${stat.runnerCount} lopers`}</em>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function rankingRunnerLabel(runner: { runnerName: string; runnerNumber: string | null }) {
  return runner.runnerNumber ? `${runner.runnerNumber} - ${runner.runnerName}` : runner.runnerName;
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

function DisplayBrand({ tone }: { tone: 'light' | 'dark' }) {
  return (
    <div className={`display-brand display-brand--${tone}`}>
      <img src="/brand/apolloon-logo.png" alt="Apolloon" width={560} height={169} fetchPriority="high" />
      <span>you&apos;ll never walk alone</span>
    </div>
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

function OutsideRecordFlash({ lap, mode }: { lap: LapRecord; mode: PublicRecordMode }) {
  return (
    <section className="outside-record-flash" aria-live="polite">
      <div className="record-flash-content">
        <span>{publicRecordModeTitle(mode)}</span>
        <strong>{formatDurationMs(lap.durationMs)}</strong>
        <em>{lapRunnerLabel(lap)}</em>
      </div>
    </section>
  );
}

function OutsideBurgieFlash({ event }: { event: RaceEvent }) {
  return (
    <section className="outside-record-flash outside-record-flash--burgie" aria-live="polite">
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
  return event.runnerNumber ? `${event.runnerNumber} - ${event.runnerName}` : event.runnerName;
}

function buildLabelStats(labels: Label[], runners: Runner[], laps: LapRecord[]) {
  const totals = new Map(
    labels.map((label) => [
      label.id,
      { label, runnerIds: new Set<string>(), laps: 0, calculatedTarget: 0 },
    ])
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
    .sort(
      (a, b) =>
        (a.label.sortOrder ?? 9999) - (b.label.sortOrder ?? 9999) ||
        a.label.name.localeCompare(b.label.name)
    );
}
