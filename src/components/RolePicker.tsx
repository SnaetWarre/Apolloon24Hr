import React from 'react';
import { useAppData } from '../app/index';
import { preloadAdminView, preloadAnalysisView, preloadDisplayViews } from '../lazyViews';
import type { LiveAppSnapshot } from '../types';

const selectHostData = ({ host }: LiveAppSnapshot) => ({ host });

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
    preload: preloadDisplayViews,
  },
  {
    path: '/display/inside',
    title: 'Binnenscherm',
    description: 'Rankings, minicompetities en progressie per label.',
    preload: preloadDisplayViews,
  },
  {
    path: '/analysis',
    title: 'Analyse & Export',
    description: 'Live rondedata bekijken en CSV/JSON exporteren.',
    preload: preloadAnalysisView,
  },
  {
    path: '/admin',
    title: 'Admin / Import / Labels',
    description: 'Google Sheets CSV importeren en labels beheren.',
    preload: preloadAdminView,
  },
];

export function RolePicker({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { host } = useAppData(selectHostData);

  return (
    <>
      <div className="hero">
        <div className="hero__content">
          <img className="hero-logo" src="/brand/apolloon-logo.png" alt="Apolloon" width={560} height={169} fetchPriority="high" />
          <h1 className="app-title">Apolloon telsysteem</h1>
          <p className="tagline">Open deze pagina op elke laptop en kies de juiste rol.</p>
        </div>
        <div className="hero__status" role="status">
          <span className="hero__status-dot" aria-hidden="true" />
          Lokaal wedstrijdsysteem
        </div>
      </div>
      <div className="role-grid">
        {ROLES.map((role) => (
          <button
            key={role.path}
            className="role-card"
            onPointerEnter={role.preload}
            onFocus={role.preload}
            onClick={() => onNavigate(role.path)}
          >
            <span className="role-card__title">{role.title}</span>
            <small>{role.description}</small>
            <span className="role-card__action" aria-hidden="true">
              Open rol
            </span>
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
