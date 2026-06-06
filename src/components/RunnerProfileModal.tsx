import React from 'react';
import { useAppStore } from '../store';
import { formatDurationMs } from '../lib/time';
import { labelKindOrder, labelKindTitle } from './LabelBadge';
import type { Label } from '../types';

export function RunnerProfileModal({ runnerId, onClose }: { runnerId: string; onClose: () => void }) {
  const runner = useAppStore((state) => state.runners.find((item) => item.id === runnerId));
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

  if (!runner) return null;

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

function groupLabels(labels: Label[]) {
  const grouped = new Map<string, typeof labels>();
  [...labels]
    .sort((a, b) => labelKindOrder(a.kind) - labelKindOrder(b.kind) || a.name.localeCompare(b.name))
    .forEach((label) => {
      if (!grouped.has(label.kind)) grouped.set(label.kind, []);
      grouped.get(label.kind)?.push(label);
    });
  return [...grouped.entries()];
}
