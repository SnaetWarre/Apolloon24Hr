import React from 'react';
import { useAppData } from '../app/index';
import { preloadAdminView, preloadAnalysisView, preloadDisplayViews, preloadKobeTacticsView } from '../lazyViews';
import type { LiveAppSnapshot } from '../types';

const selectHostData = ({ host }: LiveAppSnapshot) => ({ host });

const ROLE_GROUPS = [
  {
    title: 'Wedstrijd bedienen',
    isOperatorGroup: true,
    roles: [
      {
        path: '/queue',
        title: 'Wachtrij & wisselzone',
        description: 'Lopers toevoegen, opwarmen en de wachtrij beheren.',
        preload: undefined,
      },
      {
        path: '/timing',
        title: 'Timing',
        description: 'De huidige loper afklokken en de volgende starten.',
        preload: undefined,
      },
    ],
  },
  {
    title: 'Schermen en beheer',
    isOperatorGroup: false,
    roles: [
      {
        path: '/display/outside',
        title: 'Buitenscherm',
        description: 'Huidige en volgende loper voor het publiek.',
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
        title: 'Analyse en export',
        description: 'Live rondedata bekijken en exporteren.',
        preload: preloadAnalysisView,
      },
      {
        path: '/tactics',
        title: "Kobe's tactiek",
        description: 'Live wedstrijdstrategie en historische vergelijkingen.',
        preload: preloadKobeTacticsView,
      },
      {
        path: '/admin',
        title: 'Beheer',
        description: 'Import, labels en wedstrijdinstellingen beheren.',
        preload: preloadAdminView,
      },
    ],
  },
] as const;

export function RolePicker({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { host } = useAppData(selectHostData);

  return (
    <>
      <div className="hero home-hero">
        <div className="hero__content">
          <img className="hero-logo" src="/brand/apolloon-logo.png" alt="Apolloon" width={560} height={169} fetchPriority="high" />
          <span className="page-kicker">24 urenloop · Wedstrijdorganisatie</span>
          <h1 className="app-title">Elke ronde telt.</h1>
          <p className="tagline">Kies je werkplek. Hou de wedstrijd in beweging.</p>
        </div>
      </div>
      <div className="role-sections">
        {ROLE_GROUPS.map((roleGroup) => (
          <section key={roleGroup.title} className={`role-section${roleGroup.isOperatorGroup ? ' role-section--operations' : ''}`}>
            <h2>{roleGroup.title}</h2>
            <div className="role-grid">
              {roleGroup.roles.map((role) => (
                <button
                  key={role.path}
                  className="role-card"
                  onPointerEnter={role.preload}
                  onFocus={role.preload}
                  onClick={() => onNavigate(role.path)}
                >
                  <span>
                    <span className="role-card__title">{role.title}</span>
                    <small>{role.description}</small>
                  </span>
                  <span className="role-card__arrow" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          </section>
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
