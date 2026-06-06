import React from 'react';
import { useAppStore } from '../store';
import { formatDurationMs, nowMs } from '../lib/time';
import type { Runner } from '../types';

function TimerCell({ runner }: { runner: Runner }) {
  const tick = useSecondTick();
  if (!runner.statusSince) return <span>—</span>;
  if (runner.status !== 'warming_up' && runner.status !== 'waiting') return <span>—</span>;
  const ms = nowMs() - runner.statusSince + tick;
  return <span>{formatDurationMs(ms)}</span>;
}

function useSecondTick() {
  const [, setN] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setN((n) => (n + 1) % 1_000_000), 100);
    return () => clearInterval(id);
  }, []);
  return 0; // used to force re-render
}

export const RunnerTable: React.FC = () => {
  const runners = useAppStore((s) => s.runners);
  const search = useAppStore((s) => s.search);
  const setStatus = useAppStore((s) => s.setStatus);
  const selectedRunnerId = useAppStore((s) => s.selectedRunnerId);
  const selectRunner = useAppStore((s) => s.selectRunner);

  const sorted = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? runners.filter((r) => r.name.toLowerCase().includes(q)) : runners;
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [runners, search]);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Name</th>
            <th>Status</th>
            <th>Warm-up</th>
            <th>Waiting</th>
            <th>—</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.id} onClick={() => selectRunner(r.id)} style={{ background: selectedRunnerId === r.id ? '#e6f0ff' : undefined }}>
              <td>{r.name}</td>
              <td>{r.status}</td>
              <td>{r.status === 'warming_up' ? <TimerCell runner={r} /> : '—'}</td>
              <td>{r.status === 'waiting' ? <TimerCell runner={r} /> : '—'}</td>
              <td>—</td>
              <td style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setStatus(r.id, 'warming_up')}>Warm-up</button>
                <button onClick={() => setStatus(r.id, 'waiting')}>Queue</button>
                <button onClick={() => setStatus(r.id, 'ran')}>Ran</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// manual run time removed in 3-column workflow

