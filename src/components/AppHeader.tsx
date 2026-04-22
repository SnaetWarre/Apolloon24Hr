import React from 'react';
import { useAppStore } from '../store';
// ConnectionInfoModal removed; showing a simple hint instead

export const AppHeader: React.FC = () => {
  const search = useAppStore((s) => s.search);
  const setSearch = useAppStore((s) => s.setSearch);
  const addRunner = useAppStore((s) => s.addRunner);
  const [newRunnerName, setNewRunnerName] = React.useState('');
  const [hostHint, setHostHint] = React.useState<string>('');
  React.useEffect(() => {
    fetch('/api/host-info')
      .then((r) => r.json())
      .then((data) => {
        const first = (data?.addresses || [])[0];
        const port = data?.port || 5173;
        if (first?.address) setHostHint(`Plak dit in de browser op een ander apparaat: http://${first.address}:${port}`);
      })
      .catch(() => {});
  }, []);

  function handleAddRunner() {
    const trimmed = newRunnerName.trim();
    if (!trimmed) return;
    addRunner(trimmed);
    setNewRunnerName('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddRunner();
    }
  }

  return (
    <>
      <div className="header-bar" style={{ marginBottom: 24 }}>
        <input
          placeholder="Naam loper toevoegen…"
          value={newRunnerName}
          onChange={(e) => setNewRunnerName(e.target.value)}
          onKeyDown={handleKeyDown}
          className="input input--name"
        />
        <button 
          onClick={handleAddRunner} 
          className="btn btn--primary"
        >
          ➕ Toevoegen
        </button>
        <input
          placeholder="🔍 Zoek op naam…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="input input--search input--stretch"
        />
        <div style={{ flex: 1 }} />
        {hostHint && (
          <div style={{
            background: 'rgba(255,255,255,0.1)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 14,
            whiteSpace: 'nowrap',
            maxWidth: 520,
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}>
            {hostHint}
          </div>
        )}
      </div>
    </>
  );
};


