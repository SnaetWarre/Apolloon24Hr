import React from 'react';
import { useAppStore } from '../store';
import { ConnectionInfoModal } from './ConnectionInfoModal';

export const AppHeader: React.FC = () => {
  const search = useAppStore((s) => s.search);
  const setSearch = useAppStore((s) => s.setSearch);
  const addRunner = useAppStore((s) => s.addRunner);
  const [newRunnerName, setNewRunnerName] = React.useState('');
  const [showConnectionInfo, setShowConnectionInfo] = React.useState(false);

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
        <button
          onClick={() => setShowConnectionInfo(true)}
          className="btn"
          style={{ whiteSpace: 'nowrap' }}
        >
          📱 Ander apparaat verbinden
        </button>
      </div>
      <ConnectionInfoModal 
        isOpen={showConnectionInfo}
        onClose={() => setShowConnectionInfo(false)}
      />
    </>
  );
};


