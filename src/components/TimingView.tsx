import React from 'react';
import { useAppStore } from '../store';
import { formatDurationMs, nowMs } from '../lib/time';
import type { Runner } from '../types';
import { LabelBadge } from './LabelBadge';

export function TimingView() {
  const runners = useAppStore((state) => state.runners);
  const laps = useAppStore((state) => state.laps);
  const race = useAppStore((state) => state.race);
  const handoff = useAppStore((state) => state.handoff);
  const startNext = useAppStore((state) => state.startNext);
  const undoLastHandoff = useAppStore((state) => state.undoLastHandoff);
  const finishRace = useAppStore((state) => state.finishRace);
  const [message, setMessage] = React.useState<string | null>(null);
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    const id = window.setInterval(() => setTick((tick) => (tick + 1) % 1_000_000), 250);
    return () => window.clearInterval(id);
  }, []);

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextRunner(runners);
  const lastLap = laps[0] || null;
  const activePreviousLap = activeRunner ? laps.find((lap) => lap.runnerId === activeRunner.id) || null : null;

  async function runHandoff() {
    setMessage(null);
    try {
      if (activeRunner) await handoff();
      else await startNext();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Timing actie mislukt');
    }
  }

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
      if (event.code === 'Space') {
        event.preventDefault();
        runHandoff();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeRunner]);

  async function undo() {
    if (!window.confirm('Laatste handoff ongedaan maken?')) return;
    setMessage(null);
    try {
      await undoLastHandoff();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Undo mislukt');
    }
  }

  async function finish() {
    if (!window.confirm('Race beeindigen? De actieve loper wordt gestopt zonder extra lap.')) return;
    await finishRace();
  }

  return (
    <>
      <div className="hero hero--compact">
        <h1 className="app-title">Telsysteem 2 - Timing</h1>
        <p className="tagline">
          De race start niet automatisch. De eerste spatie start de race en de eerste loper; daarna klokt
          spatie de huidige loper af en start meteen de volgende.
        </p>
      </div>

      <div className="timing-grid">
        <TimingCard
          title="Huidige loper"
          runner={activeRunner}
          empty="Nog niemand actief"
          accent
          extra={
            activeRunner && race.activeStartedAt ? (
              <span className="live-time">{formatDurationMs(nowMs() - race.activeStartedAt)}</span>
            ) : null
          }
        />
        <TimingCard title="Volgende loper" runner={nextRunner} empty="Geen loper in wachtrij" />
      </div>

      <div className="timing-actions">
        <button className="btn btn--primary btn--xl" onClick={runHandoff}>
          {activeRunner ? 'Spatie: handoff' : 'Start race + eerste loper'}
        </button>
        <button className="btn btn--ghost" onClick={undo}>
          Undo laatste handoff
        </button>
        <button className="btn btn--danger" onClick={finish}>
          Race beeindigen
        </button>
      </div>

      {message && <div className="warning-banner">{message}</div>}

      <div className="stats-grid">
        <div className="stat-panel">
          <span className="muted-label">Race start</span>
          <strong>{race.raceStartedAt ? new Date(race.raceStartedAt).toLocaleTimeString() : 'Nog niet gestart'}</strong>
        </div>
        <div className="stat-panel">
          <span className="muted-label">Laatste ronde</span>
          <strong>{lastLap ? `${lastLap.runnerName} - ${formatDurationMs(lastLap.durationMs)}` : 'Nog geen ronde'}</strong>
        </div>
        <div className="stat-panel">
          <span className="muted-label">Vorige ronde huidige loper</span>
          <strong>{activePreviousLap ? formatDurationMs(activePreviousLap.durationMs) : 'Geen vorige ronde'}</strong>
        </div>
        <div className="stat-panel">
          <span className="muted-label">Wachtrij</span>
          <strong>{runners.filter((runner) => runner.status === 'waiting').length} lopers klaar</strong>
        </div>
      </div>
    </>
  );
}

function TimingCard({
  title,
  runner,
  empty,
  accent,
  extra,
}: {
  title: string;
  runner: Runner | null;
  empty: string;
  accent?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <section className={`timing-card${accent ? ' timing-card--accent' : ''}`}>
      <span className="muted-label">{title}</span>
      {runner ? (
        <>
          <strong>
            {runner.runnerNumber && <span>{runner.runnerNumber} - </span>}
            {runner.name}
          </strong>
          <div className="display-labels">
            {runner.labels.map((label) => (
              <LabelBadge key={label.id} label={label} />
            ))}
          </div>
          {extra}
        </>
      ) : (
        <strong>{empty}</strong>
      )}
    </section>
  );
}

function getNextRunner(runners: Runner[]) {
  return (
    runners
      .filter((runner) => runner.status === 'waiting')
      .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0))[0] || null
  );
}
