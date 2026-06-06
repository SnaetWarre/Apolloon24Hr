import React from 'react';
import { useAppStore } from '../store';
import { formatDurationMs, nowMs } from '../lib/time';
import type { Label, Runner } from '../types';
import { LabelBadge } from './LabelBadge';

export function OutsideDisplay({ onNavigate }: { onNavigate: (path: string) => void }) {
  const runners = useAppStore((state) => state.runners);
  const race = useAppStore((state) => state.race);
  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextRunner(runners);
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    const id = window.setInterval(() => setTick((tick) => (tick + 1) % 1_000_000), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <main className="display-root display-root--outside">
      <button className="display-home" onClick={() => onNavigate('/')}>
        Start
      </button>
      <section className="outside-current">
        <span>Nu op de piste</span>
        <strong>{activeRunner ? runnerName(activeRunner) : 'Nog niemand gestart'}</strong>
        {activeRunner && race.activeStartedAt && (
          <em>{formatDurationMs(nowMs() - race.activeStartedAt)}</em>
        )}
        {activeRunner && <DisplayLabels labels={activeRunner.labels} />}
      </section>
      <section className="outside-next">
        <span>Volgende loper</span>
        <strong>{nextRunner ? runnerName(nextRunner) : 'Geen loper in wachtrij'}</strong>
        {nextRunner && <DisplayLabels labels={nextRunner.labels} />}
      </section>
    </main>
  );
}

export function InsideDisplay({ onNavigate }: { onNavigate: (path: string) => void }) {
  const runners = useAppStore((state) => state.runners);
  const labels = useAppStore((state) => state.labels);
  const laps = useAppStore((state) => state.laps);
  const ranking = [...runners]
    .sort(
      (a, b) =>
        b.lapCount - a.lapCount ||
        (a.averageLapMs ?? Number.MAX_SAFE_INTEGER) - (b.averageLapMs ?? Number.MAX_SAFE_INTEGER)
    )
    .slice(0, 10);

  const labelStats = labels
    .map((label) => buildLabelStat(label, runners))
    .filter((stat) => stat.runnerCount > 0)
    .sort((a, b) => b.laps - a.laps);

  return (
    <main className="display-root display-root--inside">
      <button className="display-home" onClick={() => onNavigate('/')}>
        Start
      </button>
      <header className="inside-header">
        <h1>Live standen</h1>
        <span>{laps.length} rondes geregistreerd</span>
      </header>
      <div className="inside-grid">
        <section className="display-panel">
          <h2>Ranking</h2>
          <div className="ranking-list">
            {ranking.map((runner, index) => (
              <div key={runner.id} className="ranking-row">
                <span>{index + 1}</span>
                <strong>{runnerName(runner)}</strong>
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
                  <strong>{stat.label.name}</strong>
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

function getNextRunner(runners: Runner[]) {
  return (
    runners
      .filter((runner) => runner.status === 'waiting')
      .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0))[0] || null
  );
}

function runnerName(runner: Runner) {
  return runner.runnerNumber ? `${runner.runnerNumber} - ${runner.name}` : runner.name;
}

function buildLabelStat(label: Label, runners: Runner[]) {
  const labelRunners = runners.filter((runner) => runner.labels.some((item) => item.id === label.id));
  const laps = labelRunners.reduce((sum, runner) => sum + runner.lapCount, 0);
  const target = labelRunners.reduce((sum, runner) => sum + (runner.targetLaps || 0), 0);
  return {
    label,
    runnerCount: labelRunners.length,
    laps,
    target,
    percent: target > 0 ? (laps / target) * 100 : 0,
  };
}
