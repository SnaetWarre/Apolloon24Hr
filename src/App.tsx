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
    <div style={{ 
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #1e3a8a 0%, #0f172a 100%)',
      color: '#ffffff',
      padding: '24px'
    }}>
      {!authed ? (
        <Login onSuccess={() => setAuthed(true)} />
      ) : (
        <>
          <div style={{
            background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
            padding: '20px 32px',
            marginBottom: '24px',
            borderRadius: '12px',
            boxShadow: '0 8px 32px rgba(59, 130, 246, 0.4)',
            border: '2px solid rgba(147, 197, 253, 0.3)'
          }}>
            <h1 style={{ 
              fontSize: '36px', 
              fontWeight: 700, 
              margin: 0,
              textShadow: '2px 2px 8px rgba(0,0,0,0.3)',
              letterSpacing: '1px'
            }}>
              🏃 Apolloon Runner Tracker
            </h1>
            <p style={{ 
              margin: '8px 0 0 0', 
              fontSize: '14px', 
              opacity: 0.9,
              fontStyle: 'italic'
            }}>
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


