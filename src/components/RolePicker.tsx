import React from 'react';
import { Link } from '@tanstack/react-router';
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
    title: 'Analyse en beheer',
    isOperatorGroup: false,
    roles: [
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
  {
    title: 'Publieksschermen',
    isOperatorGroup: false,
    roles: [
      {
        path: '/display/inside',
        title: 'Binnenscherm',
        description: 'Rankings en progressie van lopers en ploegen.',
        preload: preloadDisplayViews,
      },
      {
        path: '/display/outside',
        title: 'Buitenscherm',
        description: 'De huidige en volgende loper op de piste.',
        preload: preloadDisplayViews,
      },
    ],
  },
] as const;

export function RolePicker() {
  const { host } = useAppData(selectHostData);
  const [copied, setCopied] = React.useState(false);

  async function copyHostUrl() {
    if (!host) return;
    try {
      await navigator.clipboard.writeText(host.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <div className="hero home-hero">
        <img className="hero-logo" src="/brand/apolloon-logo.png" alt="Apolloon" width={560} height={169} fetchPriority="high" />
        <div className="hero__content">
          <h1 className="app-title">Elke ronde telt.</h1>
          <p className="tagline">Je werkplek voor de 24 urenloop.</p>
        </div>
      </div>
      <div className="role-sections">
        {ROLE_GROUPS.map((roleGroup) => (
          <section key={roleGroup.title} className={`role-section${roleGroup.isOperatorGroup ? ' role-section--operations' : ''}`}>
            <h2>{roleGroup.title}</h2>
            <div className="role-grid">
              {roleGroup.roles.map((role) => (
                <Link
                  key={role.path}
                  className="role-card"
                  to={role.path}
                  onPointerEnter={role.preload}
                  onFocus={role.preload}
                >
                  <span>
                    <span className="role-card__title">{role.title}</span>
                    <small>{role.description}</small>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
      {host && (
        <div className="host-hint host-hint--with-copy">
          Open op een andere laptop: <strong>{host.url}</strong>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copyHostUrl()}>
            {copied ? 'Gekopieerd!' : 'Kopieer'}
          </button>
        </div>
      )}
    </>
  );
}
