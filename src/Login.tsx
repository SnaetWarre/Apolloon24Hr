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
      <form onSubmit={onSubmit} className="login-form" style={{ 
        display: 'flex', 
        flexDirection: 'column',
        gap: 16, 
        alignItems: 'stretch',
        padding: 32,
        background: 'rgba(0, 0, 0, 0.5)',
        borderRadius: 12,
        border: '2px solid rgba(59, 130, 246, 0.3)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)'
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
          className="input"
        />
        <button 
          type="submit" 
          disabled={loading || !password.trim()}
          className="btn btn--primary"
        >
          {loading ? 'Bezig…' : 'Login'}
        </button>
        {error && <span style={{ color: '#ef4444', textAlign: 'center', fontSize: '14px', fontWeight: 600 }}>{error}</span>}
      </form>
    </div>
  );
};


