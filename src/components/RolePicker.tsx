import React from 'react';
import { useAppData } from '../app/index';
import type { AppSnapshot } from '../types';

const selectHostData = ({ host }: AppSnapshot) => ({ host });

const ROLES = [
  {
    path: '/queue',
    title: 'Telsysteem 1 - Wachtrij',
    description: 'Lopers toevoegen, opwarmen, wachtrij bepalen en volgorde aanpassen.',
  },
  {
    path: '/timing',
    title: 'Telsysteem 2 - Timing',
    description: 'Spacebar om de huidige loper af te klokken en de volgende te starten.',
  },
  {
    path: '/display/outside',
    title: 'Buitenscherm',
    description: 'Groot publiek scherm met huidige en volgende loper.',
  },
  {
    path: '/display/inside',
    title: 'Binnenscherm',
    description: 'Rankings, minicompetities en progressie per label.',
  },
  {
    path: '/analysis',
    title: 'Analyse & Export',
    description: 'Live rondedata bekijken en CSV/JSON exporteren.',
  },
  {
    path: '/admin',
    title: 'Admin / Import / Labels',
    description: 'Google Sheets CSV importeren en labels beheren.',
  },
];

export function RolePicker({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { host } = useAppData(selectHostData);

  return (
    <>
      <div className="hero">
        <div>
          <img className="hero-logo" src="/brand/apolloon-logo.png" alt="Apolloon" />
          <h1 className="app-title">Apolloon telsysteem</h1>
          <p className="tagline">Open deze pagina op elke laptop en kies de juiste rol.</p>
        </div>
      </div>
      <div className="role-grid">
        {ROLES.map((role) => (
          <button key={role.path} className="role-card" onClick={() => onNavigate(role.path)}>
            <span>{role.title}</span>
            <small>{role.description}</small>
          </button>
        ))}
      </div>
      {host && (
        <div className="host-hint">
          Event URL voor alle laptops: <strong>{host.url}</strong>
        </div>
      )}
    </>
  );
}
