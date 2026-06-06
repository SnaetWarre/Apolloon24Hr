import React from 'react';
import { useAppStore } from '../store';

export const AppHeader: React.FC = () => {
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const addRunner = useAppStore((state) => state.addRunner);
  const host = useAppStore((state) => state.host);
  const [runnerNumber, setRunnerNumber] = React.useState('');
  const [newRunnerName, setNewRunnerName] = React.useState('');

  async function handleAddRunner() {
    const name = newRunnerName.trim();
    if (!name) return;
    await addRunner({
      name,
      runnerNumber: runnerNumber.trim() || null,
    });
    setRunnerNumber('');
    setNewRunnerName('');
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleAddRunner();
    }
  }

  return (
    <div className="header-bar">
      <input
        placeholder="Nr."
        value={runnerNumber}
        onChange={(event) => setRunnerNumber(event.target.value)}
        onKeyDown={handleKeyDown}
        className="input input--number"
      />
      <input
        placeholder="Naam loper toevoegen..."
        value={newRunnerName}
        onChange={(event) => setNewRunnerName(event.target.value)}
        onKeyDown={handleKeyDown}
        className="input input--name"
      />
      <button onClick={handleAddRunner} className="btn btn--primary">
        Toevoegen
      </button>
      <input
        placeholder="Zoek op naam, nummer of label..."
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="input input--search input--stretch"
      />
      {host && <div className="header-hint">{host.url}</div>}
    </div>
  );
};
