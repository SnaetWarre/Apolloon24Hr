import React from 'react';
import { useAppStore } from '../store';

export const AppHeader: React.FC = () => {
  const search = useAppStore((s) => s.search);
  const setSearch = useAppStore((s) => s.setSearch);
  const addRunner = useAppStore((s) => s.addRunner);
  const [newRunnerName, setNewRunnerName] = React.useState('');

  function handleAddRunner() {
    const trimmed = newRunnerName.trim();
    if (!trimmed) return;
    addRunner(trimmed);
    setNewRunnerName('');
  }

  function handleKeyPress(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      handleAddRunner();
    }
  }

  return (
    <div className="header-bar" style={{ marginBottom: 24 }}>
      <input
        placeholder="Naam loper toevoegen…"
        value={newRunnerName}
        onChange={(e) => setNewRunnerName(e.target.value)}
        onKeyPress={handleKeyPress}
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
    </div>
  );
};


