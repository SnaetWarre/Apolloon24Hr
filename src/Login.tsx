import React from 'react';
import { login } from './auth';

export const Login: React.FC<{ onSuccess: () => void }> = ({ onSuccess }) => {
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const ok = await login(password);
      if (ok) onSuccess();
      else setError('Verkeerd wachtwoord');
    } catch {
      setError('Login mislukt');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100vh'
    }}>
      <form onSubmit={onSubmit} style={{ 
        display: 'flex', 
        flexDirection: 'column',
        gap: 16, 
        alignItems: 'stretch',
        padding: 32,
        background: 'rgba(0, 0, 0, 0.5)',
        borderRadius: 12,
        border: '2px solid rgba(59, 130, 246, 0.3)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
        minWidth: 350
      }}>
        <div style={{
          textAlign: 'center',
          marginBottom: 16
        }}>
          <h1 style={{ 
            fontSize: '28px', 
            fontWeight: 700,
            color: '#3b82f6',
            marginBottom: 8
          }}>
            🏃 Apolloon
          </h1>
          <p style={{ 
            fontSize: '14px',
            color: '#93c5fd',
            fontStyle: 'italic'
          }}>
            You'll never walk alone
          </p>
        </div>
        <input
          type="password"
          placeholder="Wachtwoord"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          style={{
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
        <button 
          type="submit" 
          disabled={loading || !password.trim()}
          style={{
            fontSize: 16,
            padding: '12px 24px',
            fontWeight: 700,
            background: loading || !password.trim() 
              ? 'rgba(100, 100, 100, 0.5)' 
              : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: loading || !password.trim() ? 'not-allowed' : 'pointer',
            boxShadow: loading || !password.trim() 
              ? 'none' 
              : '0 4px 12px rgba(59, 130, 246, 0.4)',
            transition: 'all 0.3s ease',
            textTransform: 'uppercase',
            letterSpacing: '0.5px'
          }}
        >
          {loading ? 'Bezig…' : 'Login'}
        </button>
        {error && <span style={{ color: '#ef4444', textAlign: 'center', fontSize: '14px', fontWeight: 600 }}>{error}</span>}
      </form>
    </div>
  );
};


