import React from 'react';
import { useAppStore } from '../store';
import { formatDurationMs, formatElapsedSeconds, nowMs } from '../lib/time';
import { useAnimationFrameTick } from '../lib/useAnimationFrameTick';
import { labelKindOrder, labelKindTitle } from './LabelBadge';
import type { Label } from '../types';

export function RunnerProfileModal({ runnerId, onClose }: { runnerId: string; onClose: () => void }) {
  const runner = useAppStore((state) => state.runners.find((item) => item.id === runnerId));
  const laps = useAppStore((state) => state.laps.filter((lap) => lap.runnerId === runnerId));
  const labels = useAppStore((state) => state.labels);
  const updateRunner = useAppStore((state) => state.updateRunner);
  const [runnerNumber, setRunnerNumber] = React.useState('');
  const [name, setName] = React.useState('');
  const [targetLaps, setTargetLaps] = React.useState('');
  const [historicalAvg, setHistoricalAvg] = React.useState('');
  const [historicalBest, setHistoricalBest] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [selectedLabels, setSelectedLabels] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!runner) return;
    setRunnerNumber(runner.runnerNumber || '');
    setName(runner.name);
    setTargetLaps(runner.targetLaps?.toString() || '');
    setHistoricalAvg(msToSecondsInput(runner.historicalAvgMs));
    setHistoricalBest(msToSecondsInput(runner.historicalBestMs));
    setNotes(runner.notes || '');
    setSelectedLabels(runner.labels.map((label) => label.id));
  }, [runner]);

  useAnimationFrameTick(Boolean(runner?.statusSince && ['warming_up', 'waiting', 'running'].includes(runner.status)));

  if (!runner) return null;

  const latestLap = laps[0] || null;
  const statusTime = statusElapsedLabel(runner.status, runner.statusSince);
  const recentLaps = laps.slice(0, 5);

  async function save() {
    await updateRunner(runnerId, {
      runnerNumber,
      name,
      targetLaps: targetLaps ? Number(targetLaps) : null,
      historicalAvgMs: historicalAvg ? Math.round(Number(historicalAvg.replace(',', '.')) * 1000) : null,
      historicalBestMs: historicalBest ? Math.round(Number(historicalBest.replace(',', '.')) * 1000) : null,
      notes,
      labels: selectedLabels,
    });
    onClose();
  }

  function toggleLabel(labelId: string) {
    setSelectedLabels((current) =>
      current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId]
    );
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-header">
          <div>
            <h2>Lopersprofiel</h2>
            <p>
              {runner.lapCount} toeren
              {runner.bestLapMs ? ` · snelste ${formatDurationMs(runner.bestLapMs)}` : ''}
              {runner.averageLapMs ? ` · gemiddeld ${formatDurationMs(runner.averageLapMs)}` : ''}
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Sluiten">
            x
          </button>
        </div>

        <div className="profile-stats">
          <div className="profile-stat">
            <span className="muted-label">Status</span>
            <strong>{runnerStatusLabel(runner.status)}</strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Tijd in status</span>
            <strong>{statusTime}</strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Totaal toeren</span>
            <strong>{runner.lapCount}</strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Vorige ronde</span>
            <strong>{latestLap ? formatDurationMs(latestLap.durationMs) : 'Nog geen ronde'}</strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Snelste ronde</span>
            <strong>{formatDurationMs(runner.bestLapMs)}</strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Gemiddelde</span>
            <strong>{formatDurationMs(runner.averageLapMs)}</strong>
          </div>
        </div>

        <section className="profile-laps">
          <h3>Laatste rondes</h3>
          {recentLaps.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ronde</th>
                    <th>Tijd</th>
                    <th>Rondetijd</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLaps.map((lap) => (
                    <tr key={lap.id}>
                      <td>{lap.lapNumber}</td>
                      <td>{new Date(lap.finishedAt).toLocaleTimeString()}</td>
                      <td>{formatDurationMs(lap.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-inline">Nog geen rondes geregistreerd.</div>
          )}
        </section>

        <div className="form-grid">
          <label>
            Lopersnummer
            <input className="input" value={runnerNumber} onChange={(event) => setRunnerNumber(event.target.value)} />
          </label>
          <label>
            Naam
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Doelstelling toeren
            <input
              className="input"
              type="number"
              min="0"
              value={targetLaps}
              onChange={(event) => setTargetLaps(event.target.value)}
            />
          </label>
          <label>
            Historisch gemiddelde in seconden
            <input className="input" value={historicalAvg} onChange={(event) => setHistoricalAvg(event.target.value)} />
          </label>
          <label>
            Historisch snelste in seconden
            <input className="input" value={historicalBest} onChange={(event) => setHistoricalBest(event.target.value)} />
          </label>
        </div>

        <div className="label-picker-groups">
          {groupLabels(labels).map(([kind, groupedLabels]) => (
            <section key={kind} className="label-picker-group">
              <h3>{labelKindTitle(kind)}</h3>
              <div className="label-picker">
                {groupedLabels.map((label) => (
                  <label key={label.id} className="check-pill">
                    <input
                      type="checkbox"
                      checked={selectedLabels.includes(label.id)}
                      onChange={() => toggleLabel(label.id)}
                    />
                    <span style={{ borderColor: label.color }}>
                      {label.imageUrl ? (
                        <img src={label.imageUrl} alt="" className="label-image" />
                      ) : (
                        <i className="label-dot" style={{ background: label.color }} />
                      )}
                      {label.name}
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ))}
        </div>

        <label className="stacked-label">
          Notities
          <textarea className="input textarea" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>

        <div className="modal-actions">
          <button className="btn btn--ghost" onClick={onClose}>
            Annuleer
          </button>
          <button className="btn btn--primary" onClick={save}>
            Opslaan
          </button>
        </div>
      </div>
    </div>
  );
}

function msToSecondsInput(ms: number | null) {
  if (ms === null || ms === undefined) return '';
  return String(Math.round(ms / 1000));
}

function statusElapsedLabel(status: string, statusSince: number | null) {
  if (!statusSince || status === 'registered' || status === 'ran') return '—';
  return formatElapsedSeconds(nowMs() - statusSince);
}

function runnerStatusLabel(status: string) {
  switch (status) {
    case 'registered':
      return 'Ingeschreven';
    case 'warming_up':
      return 'Aan het opwarmen';
    case 'waiting':
      return 'In de wachtrij';
    case 'running':
      return 'Loopt nu';
    case 'ran':
      return 'Heeft gelopen';
    default:
      return status;
  }
}

function groupLabels(labels: Label[]) {
  const grouped = new Map<string, typeof labels>();
  [...labels]
    .sort(
      (a, b) =>
        labelKindOrder(a.kind) - labelKindOrder(b.kind) ||
        (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) ||
        a.name.localeCompare(b.name)
    )
    .forEach((label) => {
      if (!grouped.has(label.kind)) grouped.set(label.kind, []);
      grouped.get(label.kind)?.push(label);
    });
  return [...grouped.entries()];
}
