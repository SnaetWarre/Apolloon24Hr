import React from 'react';
import { Link } from '@tanstack/react-router';
import { useAppData, useClusterStatus } from '../app/index';
import { preloadAdminView, preloadAnalysisView, preloadDisplayViews, preloadKobeTacticsView } from '../lazyViews';
import { getNextWaitingRunner } from '../lib/runners';
import { deriveSystemStatus } from '../lib/systemStatus';
import { RunnerName } from './RunnerName';
import type { LiveAppSnapshot } from '../types';

const selectStartData = ({ host, runners, race }: LiveAppSnapshot) => ({ host, runners, race });

const FOLLOW_UP_LINKS = [
  {
    path: '/analysis',
    title: 'Analyse',
    description: 'Rondetijden, lopers en ploegen. Exports van de volledige wedstrijd.',
    preload: preloadAnalysisView,
  },
  {
    path: '/tactics',
    title: "Kobe's tactiek",
    description: 'Live doelverloop en vergelijking met vorige edities.',
    preload: preloadKobeTacticsView,
  },
  {
    path: '/admin',
    title: 'Beheer',
    description: 'Voorbereiding, lopers, labels, publiek, systeem en herstel.',
    preload: preloadAdminView,
  },
] as const;

const DISPLAY_LINKS = [
  {
    path: '/display/inside',
    title: 'Binnenscherm',
    description: 'Grote tv: live loper, laatste rondes, ranking en competities.',
    note: 'Vast donker',
  },
  {
    path: '/display/outside',
    title: 'Buitenscherm',
    description: 'Aan de piste: huidige en volgende loper, records en publieke momenten.',
    note: 'Vast licht',
  },
] as const;

export function RolePicker() {
  const { host, runners, race } = useAppData(selectStartData);
  const { cluster, error: clusterError } = useClusterStatus();
  const systemStatus = deriveSystemStatus(cluster, clusterError);
  const [copied, setCopied] = React.useState(false);
  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);
  const waitingCount = runners.filter((runner) => runner.status === 'waiting').length;
  const warmingCount = runners.filter((runner) => runner.status === 'warming_up').length;

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
    <div className="start">
      <div className="start__intro">
        <h1>Elke ronde telt.</h1>
        <p>Kies waar je staat. Je keuze voor licht of donker blijft op deze laptop bewaard.</p>
        <div className="start-work">
          <Link className="work-card" to="/queue">
            <span className="work-card__place">Wisselzone</span>
            <span className="work-card__title">Wachtrij</span>
            <span className="work-card__text">Lopers aanmelden, opwarmen en klaarzetten.</span>
            <span className="work-card__live">
              {nextRunner ? (
                <>
                  <RunnerName runner={nextRunner} /> is volgende
                </>
              ) : warmingCount ? (
                `${warmingCount} aan het opwarmen, niemand klaar`
              ) : (
                'Nog niemand aangemeld'
              )}
            </span>
          </Link>
          <Link className="work-card" to="/timing">
            <span className="work-card__place">Finishlijn</span>
            <span className="work-card__title">Timing</span>
            <span className="work-card__text">Afklokken en de volgende loper starten.</span>
            <span className="work-card__live">
              {activeRunner ? (
                <>
                  <RunnerName runner={activeRunner} /> loopt
                </>
              ) : race.raceFinishedAt ? (
                'Race afgesloten'
              ) : waitingCount ? (
                `${waitingCount} klaar om te starten`
              ) : (
                'Wacht op de eerste loper'
              )}
            </span>
          </Link>
        </div>
        {host && (
          <div className="host-address">
            <span>Open op een andere laptop</span>
            <code>{host.url}</code>
            <button type="button" className="btn btn--sm" onClick={() => void copyHostUrl()}>
              {copied ? 'Gekopieerd' : 'Kopieer adres'}
            </button>
          </div>
        )}
      </div>
      <nav className="start-links" aria-label="Overige onderdelen">
        <h2>Opvolgen en beheren</h2>
        <ul>
          {FOLLOW_UP_LINKS.map((link) => (
            <li key={link.path}>
              <Link className="start-link" to={link.path} onPointerEnter={link.preload} onFocus={link.preload}>
                <strong>{link.title}</strong>
                <span>{link.description}</span>
                {link.path === '/admin' && systemStatus && (
                  <em className={`start-link__status start-link__status--${systemStatus.tone}`}>{systemStatus.title}</em>
                )}
              </Link>
            </li>
          ))}
        </ul>
        <h2>Publieksschermen</h2>
        <ul>
          {DISPLAY_LINKS.map((link) => (
            <li key={link.path}>
              <Link className="start-link" to={link.path} onPointerEnter={preloadDisplayViews} onFocus={preloadDisplayViews}>
                <strong>{link.title}</strong>
                <span>{link.description}</span>
                <em>{link.note}</em>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
