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
    <div style={{ 
      display: 'flex', 
      gap: 12, 
      alignItems: 'center', 
      marginBottom: 24,
      background: 'rgba(0, 0, 0, 0.4)',
      padding: '16px',
      borderRadius: '8px',
      border: '1px solid rgba(59, 130, 246, 0.3)',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)'
    }}>
      <input
        placeholder="Naam loper toevoegen…"
        value={newRunnerName}
        onChange={(e) => setNewRunnerName(e.target.value)}
        onKeyPress={handleKeyPress}
        style={{ 
          fontSize: 16, 
          padding: '12px 16px', 
          minWidth: 250,
          background: 'rgba(255, 255, 255, 0.95)',
          border: '2px solid transparent',
          borderRadius: '6px',
          outline: 'none',
          transition: 'all 0.3s ease'
        }}
        onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
        onBlur={(e) => e.target.style.borderColor = 'transparent'}
      />
      <button 
        onClick={handleAddRunner} 
        style={{ 
          fontSize: 16, 
          padding: '12px 24px', 
          fontWeight: 700, 
          background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', 
          color: 'white', 
          border: 'none', 
          borderRadius: '6px', 
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(59, 130, 246, 0.4)',
          transition: 'all 0.3s ease',
          textTransform: 'uppercase',
          letterSpacing: '0.5px'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0 6px 20px rgba(59, 130, 246, 0.6)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = '0 4px 12px rgba(59, 130, 246, 0.4)';
        }}
      >
        ➕ Toevoegen
      </button>
      <input
        placeholder="🔍 Zoek op naam…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ 
          flex: 1, 
          maxWidth: 320, 
          fontSize: 16, 
          padding: '12px 16px',
          background: 'rgba(255, 255, 255, 0.95)',
          border: '2px solid transparent',
          borderRadius: '6px',
          outline: 'none',
          transition: 'all 0.3s ease'
        }}
        onFocus={(e) => e.target.style.borderColor = '#3b82f6'}
        onBlur={(e) => e.target.style.borderColor = 'transparent'}
      />
      <div style={{ flex: 1 }} />
    </div>
  );
};


