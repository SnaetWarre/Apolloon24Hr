import React from 'react';
import { useAppStore } from '../store';
import { formatDurationMs, nowMs } from '../lib/time';
import { useAnimationFrameTick } from '../lib/useAnimationFrameTick';
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
  const [handoffBusy, setHandoffBusy] = React.useState(false);
  const [lastAction, setLastAction] = React.useState<string | null>(null);
  const handoffBusyRef = React.useRef(false);

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextRunner(runners);
  const recentLaps = laps.slice(0, 10);
  const activePreviousLap = activeRunner ? laps.find((lap) => lap.runnerId === activeRunner.id) || null : null;
  const handoffPreview = buildHandoffPreview(activeRunner, nextRunner);

  useAnimationFrameTick(Boolean(activeRunner && race.activeStartedAt));

  const runHandoff = React.useCallback(async () => {
    if (handoffBusyRef.current) return;
    handoffBusyRef.current = true;
    const hadActiveRunner = Boolean(activeRunner);
    setHandoffBusy(true);
    setMessage(null);
    setLastAction(null);
    try {
      if (activeRunner) await handoff();
      else await startNext();
      setLastAction(hadActiveRunner ? 'Ronde opgeslagen. Volgende loper gestart.' : 'Race gestart. Eerste loper loopt.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Timing actie mislukt');
    } finally {
      handoffBusyRef.current = false;
      setHandoffBusy(false);
    }
  }, [activeRunner, handoff, startNext]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (event.repeat || handoffBusy) return;
        runHandoff();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handoffBusy, runHandoff]);

  async function undo() {
    if (!window.confirm('Laatste handoff ongedaan maken?')) return;
    setMessage(null);
    setLastAction(null);
    try {
      await undoLastHandoff();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Undo mislukt');
    }
  }

  async function finish() {
    if (handoffBusyRef.current) return;
    if (!window.confirm('Race beeindigen? De actieve loper wordt gestopt zonder extra lap.')) return;
    setMessage(null);
    setLastAction(null);
    try {
      await finishRace();
      setLastAction('Race beeindigd.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Race beeindigen mislukt');
    }
  }

  return (
    <>
      <div className="hero hero--compact">
        <div>
          <img className="hero-logo" src="/brand/apolloon-logo.png" alt="Apolloon" />
          <h1 className="app-title">Telsysteem 2 - Timing</h1>
        </div>
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

      <div className="handoff-preview">
        <span className="muted-label">Bij volgende spatie</span>
        <strong>{handoffPreview}</strong>
      </div>

      <div className="timing-actions">
        <button className="btn btn--primary btn--xl" onClick={runHandoff} disabled={handoffBusy}>
          {handoffBusy ? 'Bezig...' : activeRunner ? 'Spatie: handoff' : 'Start eerste loper'}
        </button>
        <button className="btn btn--ghost" onClick={undo} disabled={handoffBusy}>
          Undo laatste handoff
        </button>
        <button className="btn btn--danger" onClick={finish} disabled={handoffBusy}>
          Race beeindigen
        </button>
      </div>

      {message && <div className="warning-banner">{message}</div>}
      {lastAction && <div className="success-banner">{lastAction}</div>}

      <div className="stats-grid">
        <div className="stat-panel">
          <span className="muted-label">Race start</span>
          <strong>{race.raceStartedAt ? new Date(race.raceStartedAt).toLocaleTimeString() : 'Nog niet gestart'}</strong>
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

      <section className="panel">
        <h2>Laatste 10 rondes</h2>
        {recentLaps.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tijd</th>
                  <th>Nr.</th>
                  <th>Naam</th>
                  <th>Ronde</th>
                  <th>Rondetijd</th>
                </tr>
              </thead>
              <tbody>
                {recentLaps.map((lap) => (
                  <tr key={lap.id}>
                    <td>{new Date(lap.finishedAt).toLocaleTimeString()}</td>
                    <td>{lap.runnerNumber || '-'}</td>
                    <td>{lap.runnerName}</td>
                    <td>{lap.lapNumber}</td>
                    <td>{formatDurationMs(lap.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-inline">Nog geen rondes geregistreerd</div>
        )}
      </section>
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

function buildHandoffPreview(activeRunner: Runner | null, nextRunner: Runner | null) {
  if (activeRunner && nextRunner) {
    return `${runnerLabel(activeRunner)} wordt afgeklokt -> ${runnerLabel(nextRunner)} start`;
  }
  if (!activeRunner && nextRunner) {
    return `${runnerLabel(nextRunner)} start`;
  }
  if (activeRunner && !nextRunner) {
    return 'Huidige loper wordt afgeklokt; geen volgende loper klaar';
  }
  return 'Geen loper klaar in de wachtrij';
}

function runnerLabel(runner: Runner) {
  return runner.runnerNumber ? `${runner.runnerNumber} - ${runner.name}` : runner.name;
}
