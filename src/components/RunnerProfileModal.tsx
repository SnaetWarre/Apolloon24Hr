import React from 'react';
import { useAppActions, useAppData } from '../appData';
import { formatClockTimeMs, formatDurationMs, formatElapsedSeconds, nowMs } from '../lib/time';
import { useAnimationFrameTick } from '../lib/useAnimationFrameTick';
import { labelKindOrder, labelKindTitle } from './LabelBadge';
import type { Label, Runner, RunnerStatus } from '../types';

export function RunnerProfileModal({ runnerId, onClose }: { runnerId: string; onClose: () => void }) {
  const { runners, laps: allLaps, labels } = useAppData();
  const { updateRunner } = useAppActions();
  const runner = runners.find((item) => item.id === runnerId);
  const [runnerNumber, setRunnerNumber] = React.useState('');
  const [name, setName] = React.useState('');
  const [targetLaps, setTargetLaps] = React.useState('');
  const [historicalAvgMinutes, setHistoricalAvgMinutes] = React.useState('');
  const [historicalAvgSeconds, setHistoricalAvgSeconds] = React.useState('');
  const [historicalBestMinutes, setHistoricalBestMinutes] = React.useState('');
  const [historicalBestSeconds, setHistoricalBestSeconds] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [selectedLabels, setSelectedLabels] = React.useState<string[]>([]);
  const [closePromptOpen, setClosePromptOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!runner) return;
    setRunnerNumber(runner.runnerNumber || '');
    setName(runner.name);
    setTargetLaps(runner.targetLaps?.toString() || '');
    const avgInput = msToMinuteSecondInput(runner.historicalAvgMs);
    const bestInput = msToMinuteSecondInput(runner.historicalBestMs);
    setHistoricalAvgMinutes(avgInput.minutes);
    setHistoricalAvgSeconds(avgInput.seconds);
    setHistoricalBestMinutes(bestInput.minutes);
    setHistoricalBestSeconds(bestInput.seconds);
    setNotes(runner.notes || '');
    setSelectedLabels(runner.labels.map((label) => label.id));
  }, [runner]);

  useAnimationFrameTick(Boolean(runner?.statusSince && ['warming_up', 'waiting', 'running'].includes(runner.status)));
  const laps = React.useMemo(() => allLaps.filter((lap) => lap.runnerId === runnerId), [allLaps, runnerId]);

  if (!runner) return null;

  const latestLap = laps[0] || null;
  const statusSummary = runnerStatusSummary(runner.status, runner.statusSince);
  const recentLaps = laps.slice(0, 10);
  const dirty = isDirty({
    runner,
    runnerNumber,
    name,
    targetLaps,
    historicalAvgMinutes,
    historicalAvgSeconds,
    historicalBestMinutes,
    historicalBestSeconds,
    notes,
    selectedLabels,
  });

  async function saveAndClose() {
    setSaving(true);
    try {
      await updateRunner(runnerId, {
        runnerNumber,
        name,
        targetLaps: targetLaps ? Number(targetLaps) : null,
        historicalAvgMs: minuteSecondInputToMs(historicalAvgMinutes, historicalAvgSeconds),
        historicalBestMs: minuteSecondInputToMs(historicalBestMinutes, historicalBestSeconds),
        notes,
        labels: selectedLabels,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  function requestClose() {
    if (dirty) {
      setClosePromptOpen(true);
      return;
    }
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (closePromptOpen) {
      setClosePromptOpen(false);
      return;
    }
    requestClose();
  }

  function toggleLabel(labelId: string) {
    setSelectedLabels((current) =>
      current.includes(labelId) ? current.filter((id) => id !== labelId) : [...current, labelId]
    );
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal" onKeyDown={handleKeyDown}>
        <div className="modal-header">
          <div>
            <h2>Lopersprofiel</h2>
            <p>
              {runner.lapCount} toeren
              {runner.bestLapMs ? ` · snelste ${formatDurationMs(runner.bestLapMs)}` : ''}
              {runner.averageLapMs ? ` · gemiddeld ${formatDurationMs(runner.averageLapMs)}` : ''}
            </p>
          </div>
          <button className="icon-btn" onClick={requestClose} aria-label="Sluiten">
            x
          </button>
        </div>

        <div className="profile-stats">
          <div className="profile-stat">
            <span className="muted-label">{statusSummary.title}</span>
            <strong>{statusSummary.detail || '—'}</strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Totaal toeren</span>
            <strong>{runner.lapCount}</strong>
          </div>
          <div className="profile-stat">
            <span className="muted-label">Laatste ronde</span>
            <strong>{latestLap ? formatDurationMs(latestLap.durationMs) : 'Nog geen ronde'}</strong>
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
                      <td>{formatClockTimeMs(lap.finishedAt)}</td>
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
            Historisch gemiddelde
            <div className="duration-input">
              <input
                className="input"
                type="number"
                min="0"
                value={historicalAvgMinutes}
                onChange={(event) => setHistoricalAvgMinutes(event.target.value)}
                placeholder="min"
              />
              <input
                className="input"
                type="number"
                min="0"
                max="59"
                value={historicalAvgSeconds}
                onBlur={() => setHistoricalAvgSeconds(normalizeSecondsInput(historicalAvgSeconds))}
                onChange={(event) => setHistoricalAvgSeconds(event.target.value)}
                placeholder="sec"
              />
            </div>
          </label>
          <label>
            Historisch snelste
            <div className="duration-input">
              <input
                className="input"
                type="number"
                min="0"
                value={historicalBestMinutes}
                onChange={(event) => setHistoricalBestMinutes(event.target.value)}
                placeholder="min"
              />
              <input
                className="input"
                type="number"
                min="0"
                max="59"
                value={historicalBestSeconds}
                onBlur={() => setHistoricalBestSeconds(normalizeSecondsInput(historicalBestSeconds))}
                onChange={(event) => setHistoricalBestSeconds(event.target.value)}
                placeholder="sec"
              />
            </div>
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
          <button className="btn btn--ghost" onClick={requestClose}>
            Annuleer
          </button>
          <button className="btn btn--primary" onClick={saveAndClose} disabled={saving}>
            {saving ? 'Opslaan...' : 'Opslaan'}
          </button>
        </div>

        {closePromptOpen && (
          <div className="nested-modal-backdrop" role="dialog" aria-modal="true">
            <div className="confirm-modal">
              <h3>Wijzigingen opslaan?</h3>
              <p>Er zijn aanpassingen aan dit lopersprofiel.</p>
              <div className="modal-actions">
                <button className="btn btn--ghost" onClick={() => setClosePromptOpen(false)}>
                  Verder bewerken
                </button>
                <button className="btn btn--ghost" onClick={onClose}>
                  Niet opslaan
                </button>
                <button className="btn btn--primary" onClick={saveAndClose} disabled={saving}>
                  {saving ? 'Opslaan...' : 'Opslaan'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function isDirty({
  runner,
  runnerNumber,
  name,
  targetLaps,
  historicalAvgMinutes,
  historicalAvgSeconds,
  historicalBestMinutes,
  historicalBestSeconds,
  notes,
  selectedLabels,
}: {
  runner: Runner;
  runnerNumber: string;
  name: string;
  targetLaps: string;
  historicalAvgMinutes: string;
  historicalAvgSeconds: string;
  historicalBestMinutes: string;
  historicalBestSeconds: string;
  notes: string;
  selectedLabels: string[];
}) {
  const currentLabels = runner.labels.map((label) => label.id).sort().join('|');
  const nextLabels = [...selectedLabels].sort().join('|');
  const nextAvgMs = minuteSecondInputToMs(historicalAvgMinutes, historicalAvgSeconds);
  const nextBestMs = minuteSecondInputToMs(historicalBestMinutes, historicalBestSeconds);
  return (
    runnerNumber.trim() !== (runner.runnerNumber || '') ||
    name.trim() !== runner.name ||
    targetLaps.trim() !== (runner.targetLaps?.toString() || '') ||
    nextAvgMs !== (runner.historicalAvgMs ?? null) ||
    nextBestMs !== (runner.historicalBestMs ?? null) ||
    notes !== (runner.notes || '') ||
    currentLabels !== nextLabels
  );
}

function msToMinuteSecondInput(ms: number | null) {
  if (ms === null || ms === undefined) return { minutes: '', seconds: '' };
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return {
    minutes: String(Math.floor(totalSeconds / 60)),
    seconds: String(totalSeconds % 60),
  };
}

function minuteSecondInputToMs(minutes: string, seconds: string) {
  const cleanMinutes = minutes.trim();
  const cleanSeconds = seconds.trim();
  if (!cleanMinutes && !cleanSeconds) return null;
  const minuteValue = Number(cleanMinutes || 0);
  const secondValue = Number(normalizeSecondsInput(cleanSeconds || '0'));
  if (!Number.isFinite(minuteValue) || !Number.isFinite(secondValue)) return null;
  return (Math.max(0, Math.round(minuteValue)) * 60 + secondValue) * 1000;
}

function normalizeSecondsInput(value: string) {
  const seconds = Number(value.trim() || 0);
  if (!Number.isFinite(seconds)) return '';
  return String(Math.min(59, Math.max(0, Math.round(seconds))));
}

function runnerStatusSummary(status: RunnerStatus, statusSince: number | null) {
  const detail =
    statusSince && !['registered', 'ran'].includes(status)
      ? `voor ${formatElapsedSeconds(nowMs() - statusSince)}`
      : null;
  switch (status) {
    case 'registered':
      return { title: 'Ingeschreven', detail: null };
    case 'warming_up':
      return { title: 'Aan het opwarmen', detail };
    case 'waiting':
      return { title: 'In de wachtrij', detail };
    case 'running':
      return { title: 'Loopt nu', detail };
    case 'ran':
      return { title: 'Heeft gelopen', detail: null };
    default:
      return { title: status, detail };
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
