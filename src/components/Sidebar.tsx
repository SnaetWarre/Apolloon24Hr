import React from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useAppData, useClusterStatus } from '../app/index';
import { useSidebarCollapsed } from '../app/sidebar';
import { useCopyText } from '../lib/clipboard';
import { deriveSystemStatus } from '../lib/systemStatus';
import type { LiveAppSnapshot } from '../types';
import { Icon, type IconName } from './Icon';
import { LiveElapsed } from './LiveTime';
import { ThemeSwitch } from './ThemeSwitch';

type NavigationPath =
  | '/'
  | '/queue'
  | '/timing'
  | '/analysis'
  | '/tactics'
  | '/admin'
  | '/display/inside'
  | '/display/outside';

const NAVIGATION_GROUPS: ReadonlyArray<{
  title: string | null;
  items: ReadonlyArray<{ path: NavigationPath; label: string; icon: IconName }>;
}> = [
  { title: null, items: [{ path: '/', label: 'Overzicht', icon: 'overview' }] },
  {
    title: 'Wedstrijd',
    items: [
      { path: '/queue', label: 'Wachtrij', icon: 'queue' },
      { path: '/timing', label: 'Timing', icon: 'timing' },
    ],
  },
  {
    title: 'Opvolgen',
    items: [
      { path: '/analysis', label: 'Analyse', icon: 'analysis' },
      { path: '/tactics', label: 'Tactiek', icon: 'tactics' },
    ],
  },
  {
    title: 'Publieksschermen',
    items: [
      { path: '/display/inside', label: 'Binnenscherm', icon: 'displayInside' },
      {
        path: '/display/outside',
        label: 'Buitenscherm',
        icon: 'displayOutside',
      },
    ],
  },
  {
    title: 'Systeem',
    items: [{ path: '/admin', label: 'Beheer', icon: 'admin' }],
  },
];

export function AppShellFrame({ children }: { children: React.ReactNode }) {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  return (
    <div className={`app-shell${collapsed ? ' is-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
      {children}
    </div>
  );
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <aside className="sidebar">
      <div className="sidebar__top">
        <Link className="sidebar__brand" to="/" aria-label="Apolloon, naar het overzicht">
          <span className="brand-mark" aria-hidden="true" />
        </Link>
        <button
          type="button"
          className="sidebar__toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Zijbalk uitklappen' : 'Zijbalk inklappen'}
          title={`${collapsed ? 'Zijbalk uitklappen' : 'Zijbalk inklappen'} (Ctrl+B)`}
        >
          <Icon name="panelLeft" />
        </button>
      </div>
      <nav className="sidebar__nav" aria-label="Hoofdnavigatie">
        {NAVIGATION_GROUPS.map((group) => (
          <div key={group.title ?? 'home'} className="sidebar__group">
            {group.title && <span className="sidebar__group-title">{group.title}</span>}
            {group.items.map((navigationItem) => {
              const isCurrentPage = pathname === navigationItem.path;
              return (
                <Link
                  key={navigationItem.path}
                  className="nav-link"
                  aria-current={isCurrentPage ? 'page' : undefined}
                  to={navigationItem.path}
                  title={navigationItem.label}
                >
                  <Icon name={navigationItem.icon} />
                  <span className="nav-link__label">{navigationItem.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar__footer">
        <SystemStatusRow />
        <RaceClock />
        <HostAddress />
        <ThemeSwitch />
      </div>
    </aside>
  );
}

const selectRaceClockData = ({ race }: LiveAppSnapshot) => ({ race });

function RaceClock() {
  const { race } = useAppData(selectRaceClockData);
  return (
    <div className="sidebar-row" title="Tijd sinds de start van de race">
      <span className="sidebar-row__label">Race</span>
      <span className="sidebar-row__value">
        {!race.raceStartedAt ? (
          'Niet gestart'
        ) : race.raceFinishedAt ? (
          'Afgesloten'
        ) : (
          <LiveElapsed startedAt={race.raceStartedAt} />
        )}
      </span>
    </div>
  );
}

const selectHostData = ({ host }: LiveAppSnapshot) => ({ host });

function HostAddress() {
  const { host } = useAppData(selectHostData);
  const [copied, copy] = useCopyText(host?.url ?? null);
  if (!host) return null;

  return (
    <button
      type="button"
      className="sidebar-row sidebar-row--button"
      onClick={copy}
      title={`Adres voor andere laptops kopiëren: ${host.url}`}
    >
      <span className="visually-hidden">Adres voor andere laptops kopiëren:</span>
      <span className="sidebar-row__address">{copied ? 'Gekopieerd' : host.url.replace(/^https?:\/\//, '')}</span>
      <Icon name={copied ? 'check' : 'copy'} size={14} className={copied ? 'icon--pop' : undefined} />
    </button>
  );
}

/** Quiet when healthy; a coloured row with the reason when something needs attention. */
function SystemStatusRow() {
  const { cluster, error } = useClusterStatus();
  const status = deriveSystemStatus(cluster, error);
  // Holds the row's place until the first status arrives, so the footer does not jump.
  if (!status)
    return (
      <div className="system-status system-status--pending" aria-hidden="true">
        <span className="system-status__dot" />
        <span className="system-status__text">
          <strong>Status laden…</strong>
        </span>
      </div>
    );
  return (
    <Link
      to="/admin"
      className={`system-status system-status--${status.tone}`}
      title={`${status.title}: ${status.detail}. Open Beheer voor details.`}
    >
      <span className="system-status__dot" aria-hidden="true" />
      <span
        role={status.tone === 'error' ? 'alert' : 'status'}
        aria-live="polite"
        aria-atomic="true"
        className="system-status__text"
      >
        <strong>{status.tone === 'healthy' ? 'Systeem in orde' : status.title}</strong>
        <span>{status.detail}</span>
      </span>
    </Link>
  );
}
