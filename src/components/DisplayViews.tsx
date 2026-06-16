import React from 'react';
import { useAppData } from '../app/index';
import { isFastestLapForRecordMode, publicRecordModeTitle } from '../lib/analysis';
import { formatClockTimeMs, formatDurationMs } from '../lib/time';
import { getNextWaitingRunner, lapRunnerLabel, runnerLabel } from '../lib/runners';
import type { Label, LapRecord, PublicRecordMode, RaceEvent, Runner } from '../types';
import { LabelBadge } from './LabelBadge';

const OUTSIDE_ALERT_VISIBLE_MS = 8_000;

export function OutsideDisplay({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { runners, race, laps, events, settings } = useAppData();
  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);
  const [recordLap, setRecordLap] = React.useState<LapRecord | null>(null);
  const [burgieEvent, setBurgieEvent] = React.useState<RaceEvent | null>(null);
  const knownLapIdsRef = React.useRef<Set<string> | null>(null);
  const knownEventIdsRef = React.useRef<Set<string> | null>(null);
  const recordTimeoutRef = React.useRef<number | null>(null);
  const burgieTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const knownLapIds = knownLapIdsRef.current;
    const latestLap = laps[0] || null;
    if (settings.publicRecordMode === 'off') {
      setRecordLap(null);
    }

    if (
      !burgieEvent &&
      knownLapIds &&
      latestLap &&
      !knownLapIds.has(latestLap.id) &&
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
    knownLapIdsRef.current = new Set(laps.map((lap) => lap.id));
  }, [burgieEvent, laps, race, settings.publicRecordMode]);

  React.useEffect(() => {
    const knownEventIds = knownEventIdsRef.current;
    const latestBurgieEvent = events.find((event) => event.type === 'burgie_gepakt') || null;

    if (knownEventIds && latestBurgieEvent && !knownEventIds.has(latestBurgieEvent.id)) {
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

    knownEventIdsRef.current = new Set(events.map((event) => event.id));
  }, [events]);

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
      <button className="display-home" onClick={() => onNavigate('/')}>
        Start
      </button>
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

export function InsideDisplay({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { runners, labels, laps } = useAppData();
  const latestLap = laps[0] || null;
  const ranking = runners
    .filter((runner) => runner.lapCount > 0 || runner.status !== 'registered')
    .sort(
      (a, b) =>
        b.lapCount - a.lapCount ||
        (a.averageLapMs ?? Number.MAX_SAFE_INTEGER) - (b.averageLapMs ?? Number.MAX_SAFE_INTEGER)
    )
    .slice(0, 10);

  const labelStats = labels
    .map((label) => buildLabelStat(label, runners))
    .filter((stat) => stat.runnerCount > 0)
    .sort(
      (a, b) =>
        (a.label.sortOrder ?? 9999) - (b.label.sortOrder ?? 9999) ||
        a.label.name.localeCompare(b.label.name)
    );

  return (
    <main className="display-root display-root--inside">
      <button className="display-home" onClick={() => onNavigate('/')}>
        Start
      </button>
      <header className="inside-header">
        <DisplayBrand tone="light" />
        <div>
          <h1>Live standen</h1>
          <span>{laps.length} rondes geregistreerd</span>
        </div>
      </header>
      <div className="inside-grid">
        <section className="display-panel inside-latest-lap">
          {latestLap ? (
            <>
              <div className="latest-lap-main">
                <h2>Net gelopen</h2>
                <strong className="latest-lap-runner">{lapRunnerLabel(latestLap)}</strong>
                <DisplayLabels labels={latestLap.labels} />
              </div>
              <div className="latest-lap-result">
                <em className="latest-lap-time">{formatDurationMs(latestLap.durationMs)}</em>
                <span className="latest-lap-meta">
                  Ronde {latestLap.lapNumber} · {formatClockTimeMs(latestLap.finishedAt)}
                </span>
              </div>
            </>
          ) : (
            <>
              <h2>Net gelopen</h2>
              <div className="empty-inline">Nog geen rondes geregistreerd</div>
            </>
          )}
        </section>
        <section className="display-panel">
          <h2>Ranking</h2>
          <div className="ranking-list">
            {ranking.map((runner, index) => (
              <div key={runner.id} className="ranking-row">
                <span>{index + 1}</span>
                <strong>{runnerLabel(runner)}</strong>
                <em>{runner.lapCount} toeren</em>
              </div>
            ))}
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

function DisplayBrand({ tone }: { tone: 'light' | 'dark' }) {
  return (
    <div className={`display-brand display-brand--${tone}`}>
      <img src="/brand/apolloon-logo.png" alt="Apolloon" />
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

function buildLabelStat(label: Label, runners: Runner[]) {
  const labelRunners = runners.filter((runner) => runner.labels.some((item) => item.id === label.id));
  const laps = labelRunners.reduce((sum, runner) => sum + runner.lapCount, 0);
  const calculatedTarget = labelRunners.reduce((sum, runner) => sum + (runner.targetLaps || 0), 0);
  const target = label.targetLaps ?? calculatedTarget;
  return {
    label,
    runnerCount: labelRunners.length,
    laps,
    target,
    percent: target > 0 ? (laps / target) * 100 : 0,
  };
}
