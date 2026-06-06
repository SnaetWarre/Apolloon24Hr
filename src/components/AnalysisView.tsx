import React from 'react';
import { useAppStore } from '../store';
import { formatDurationMs } from '../lib/time';
import type { Label, Runner } from '../types';
import { LabelBadge } from './LabelBadge';

export function AnalysisView() {
  const runners = useAppStore((state) => state.runners);
  const labels = useAppStore((state) => state.labels);
  const laps = useAppStore((state) => state.laps);
  const sortedRunners = [...runners].sort(
    (a, b) =>
      b.lapCount - a.lapCount ||
      (a.averageLapMs ?? Number.MAX_SAFE_INTEGER) - (b.averageLapMs ?? Number.MAX_SAFE_INTEGER)
  );
  const labelStats = labels
    .map((label) => buildLabelStat(label, runners))
    .filter((stat) => stat.runnerCount > 0)
    .sort(
      (a, b) =>
        (a.label.sortOrder ?? 9999) - (b.label.sortOrder ?? 9999) ||
        a.label.name.localeCompare(b.label.name)
    );
  const speedteamLaps = labelStats
    .filter((stat) => stat.label.kind === 'speedteam' || stat.label.name.toLowerCase().includes('speedteam'))
    .reduce((sum, stat) => sum + stat.laps, 0);
  const totalLaps = laps.length;

  return (
    <>
      <div className="hero hero--compact">
        <div>
          <img className="hero-logo" src="/brand/apolloon-logo.png" alt="Apolloon" />
          <h1 className="app-title">Analyse & Export</h1>
          <p className="tagline">Live rondedata voor crew en tactische opvolging.</p>
        </div>
      </div>

      <div className="export-row">
        <a className="btn btn--primary" href="/api/export/laps.csv">
          Download CSV
        </a>
        <a className="btn btn--ghost" href="/api/export/laps.json">
          Download laps.json
        </a>
        <a className="btn btn--ghost" href="/api/export/current-state.json">
          Download current-state.json
        </a>
      </div>

      <div className="stats-grid">
        <div className="stat-panel">
          <span className="muted-label">Totaal toeren</span>
          <strong>{totalLaps}</strong>
        </div>
        <div className="stat-panel">
          <span className="muted-label">Speedteam toeren</span>
          <strong>{speedteamLaps}</strong>
        </div>
        <div className="stat-panel">
          <span className="muted-label">Niet-speedteam toeren</span>
          <strong>{Math.max(0, totalLaps - speedteamLaps)}</strong>
        </div>
      </div>

      <div className="analysis-grid">
        <section className="panel">
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

        <section className="panel">
          <h2>Ranking lopers</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Naam</th>
                  <th>Toeren</th>
                  <th>Snelste</th>
                  <th>Gem.</th>
                </tr>
              </thead>
              <tbody>
                {sortedRunners.map((runner) => (
                  <tr key={runner.id}>
                    <td>{runner.runnerNumber || '-'}</td>
                    <td>{runner.name}</td>
                    <td>{runner.lapCount}</td>
                    <td>{formatDurationMs(runner.bestLapMs)}</td>
                    <td>{formatDurationMs(runner.averageLapMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="panel">
        <h2>Laatste rondes</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tijd</th>
                <th>Nr.</th>
                <th>Naam</th>
                <th>Ronde</th>
                <th>Rondetijd</th>
                <th>Labels</th>
              </tr>
            </thead>
            <tbody>
              {laps.slice(0, 30).map((lap) => (
                <tr key={lap.id}>
                  <td>{new Date(lap.finishedAt).toLocaleTimeString()}</td>
                  <td>{lap.runnerNumber || '-'}</td>
                  <td>{lap.runnerName}</td>
                  <td>{lap.lapNumber}</td>
                  <td>{formatDurationMs(lap.durationMs)}</td>
                  <td>{lap.labels.map((label) => label.name).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
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
