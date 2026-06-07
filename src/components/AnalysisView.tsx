import React from 'react';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useAppData } from '../app';
import { formatClockTimeMs, formatDurationMs } from '../lib/time';
import type { Label, Runner } from '../types';
import { LabelBadge } from './LabelBadge';

type RankingMode = 'laps' | 'fastest' | 'slowest';

export function AnalysisView() {
  const { runners, labels, laps } = useAppData();
  const [rankingMode, setRankingMode] = React.useState<RankingMode>('laps');
  const sortedRunners = runners
    .filter((runner) => runner.lapCount > 0 || runner.status !== 'registered')
    .sort(
      (a, b) =>
        b.lapCount - a.lapCount ||
        (a.averageLapMs ?? Number.MAX_SAFE_INTEGER) - (b.averageLapMs ?? Number.MAX_SAFE_INTEGER)
    );
  const fastestRunners = runners
    .filter((runner) => runner.bestLapMs != null)
    .sort((a, b) => (a.bestLapMs ?? Number.MAX_SAFE_INTEGER) - (b.bestLapMs ?? Number.MAX_SAFE_INTEGER));
  const slowestRunners = runners
    .filter((runner) => runner.slowestLapMs != null)
    .sort((a, b) => (b.slowestLapMs ?? 0) - (a.slowestLapMs ?? 0));
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
                <div className="progress-label-cell">
                  <LabelBadge label={stat.label} />
                  <span className="progress-value">
                    {stat.laps} toeren{stat.target > 0 ? ` / doel ${stat.target}` : ''}
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
          <div className="segmented-control">
            <button
              className={rankingMode === 'laps' ? 'is-active' : ''}
              onClick={() => setRankingMode('laps')}
            >
              Meeste toeren
            </button>
            <button
              className={rankingMode === 'fastest' ? 'is-active' : ''}
              onClick={() => setRankingMode('fastest')}
            >
              Snelste ronde
            </button>
            <button
              className={rankingMode === 'slowest' ? 'is-active' : ''}
              onClick={() => setRankingMode('slowest')}
            >
              Traagste ronde
            </button>
          </div>
          <div className="table-wrap">
            {rankingMode === 'laps' && <LapRankingTable runners={sortedRunners} />}
            {rankingMode === 'fastest' && <LapTimeRankingTable runners={fastestRunners} mode="fastest" />}
            {rankingMode === 'slowest' && <LapTimeRankingTable runners={slowestRunners} mode="slowest" />}
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
                  <td>{formatClockTimeMs(lap.finishedAt)}</td>
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

function LapRankingTable({ runners }: { runners: Runner[] }) {
  const columns = React.useMemo<ColumnDef<Runner>[]>(
    () => [
      { header: 'Nr.', accessorFn: (runner) => runner.runnerNumber || '-' },
      { header: 'Naam', accessorKey: 'name' },
      { header: 'Toeren', accessorKey: 'lapCount' },
      { header: 'Snelste', cell: ({ row }) => formatDurationMs(row.original.bestLapMs) },
      { header: 'Gem.', cell: ({ row }) => formatDurationMs(row.original.averageLapMs) },
    ],
    []
  );
  return <DataTable data={runners} columns={columns} />;
}

function LapTimeRankingTable({ runners, mode }: { runners: Runner[]; mode: 'fastest' | 'slowest' }) {
  const columns = React.useMemo<ColumnDef<Runner>[]>(
    () => [
      { header: 'Nr.', accessorFn: (runner) => runner.runnerNumber || '-' },
      { header: 'Naam', accessorKey: 'name' },
      { header: 'Toeren', accessorKey: 'lapCount' },
      {
        header: mode === 'fastest' ? 'Snelste' : 'Traagste',
        cell: ({ row }) => formatDurationMs(mode === 'fastest' ? row.original.bestLapMs : row.original.slowestLapMs),
      },
    ],
    [mode]
  );
  return <DataTable data={runners} columns={columns} />;
}

function DataTable<T>({ data, columns }: { data: T[]; columns: ColumnDef<T>[] }) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th key={header.id}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
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
