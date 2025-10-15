import React from 'react';
import { AppHeader } from './components/AppHeader';
import { KanbanBoard } from './components/KanbanBoard';
import { useAppStore } from './store';
import { Login } from './Login';

export const App: React.FC = () => {
  const initialize = useAppStore((s) => s.initialize);
  const selectRunner = useAppStore((s) => s.selectRunner);
  const selectedRunnerId = useAppStore((s) => s.selectedRunnerId);
  const setStatus = useAppStore((s) => s.setStatus);
  const selectNext = useAppStore((s) => s.selectNext);
  const selectPrev = useAppStore((s) => s.selectPrev);
  const [authed, setAuthed] = React.useState(false);

  React.useEffect(() => {
    if (authed) {
      initialize().catch(() => setAuthed(false));
    }
  }, [initialize, authed]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectNext();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectPrev();
        return;
      }
      if (!authed) return;
      if (e.key === 'w' || e.key === 'W') {
        if (selectedRunnerId) setStatus(selectedRunnerId, 'warming_up');
      } else if (e.key === 'q' || e.key === 'Q') {
        if (selectedRunnerId) setStatus(selectedRunnerId, 'waiting');
      } else if (e.key === 'Backspace') {
        if (selectedRunnerId) setStatus(selectedRunnerId, 'ran');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedRunnerId, setStatus, selectNext, selectPrev, authed]);

  return (
    <div className="app-root" style={{ 
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)'
    }}>
      {!authed ? (
        <Login onSuccess={() => setAuthed(true)} />
      ) : (
        <>
          <div className="hero">
            <h1 className="app-title">
              🏃 Apolloon Runner Tracker
            </h1>
            <p className="tagline">
              You'll never walk alone
            </p>
          </div>
          <AppHeader />
          <KanbanBoard />
        </>
      )}
    </div>
  );
};


