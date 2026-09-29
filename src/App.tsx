import React from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { QueueActions } from './components/QueueActions';
import { PageHeader } from './components/PageHeader';
import { KanbanBoard } from './components/KanbanBoard';
import { RolePicker } from './components/RolePicker';
import { RunnerProfileModal } from './components/RunnerProfileModal';
import { TimingView } from './components/TimingView';
import { useAppData, useClusterStatus, useConnectionLost, useRealtimeBridge } from './app/index';
import {
  LazyAdminView,
  LazyAnalysisView,
  LazyInsideDisplay,
  LazyKobeTacticsView,
  LazyOutsideDisplay,
  preloadAdminView,
  preloadAnalysisView,
  preloadDisplayViews,
  preloadKobeTacticsView,
} from './lazyViews';
import { getNextWaitingRunner } from './lib/runners';
import { LiveDuration, LiveElapsed } from './components/LiveTime';
import { RunnerName } from './components/RunnerName';
import { ThemeSwitch } from './components/ThemeSwitch';
import { Icon, type IconName } from './components/Icon';
import { setDocumentSurface } from './app/theme';
import { useSidebarCollapsed } from './app/sidebar';
import { deriveSystemStatus } from './lib/systemStatus';
import { useCopyText } from './lib/clipboard';
import type { LiveAppSnapshot } from './types';

const selectConnectionData = () => ({});
const selectQueuePageData = ({ race, runners }: LiveAppSnapshot) => ({ race, runners });

export function AppRoot() {
  const { initialized, error, refresh } = useAppData(selectConnectionData);
  useRealtimeBridge(initialized);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const displayRoute = pathname.startsWith('/display/');

  React.useLayoutEffect(() => {
    setDocumentSurface(displayRoute ? 'display' : 'operator');
  }, [displayRoute]);

  if (error) {
    return (
      <Shell>
        <div className="app-state" role="alert">
          <span className="brand-mark brand-mark--lg" role="img" aria-label="Apolloon" />
          <h1>Geen verbinding met de lokale server</h1>
          <p>{error.message}. Controleer of de Apolloon-app op deze laptop draait en probeer opnieuw.</p>
          <button className="btn btn--primary" onClick={() => void refresh()}>
            Opnieuw proberen
          </button>
        </div>
      </Shell>
    );
  }

  if (!initialized) {
    if (displayRoute)
      return (
        <div className="display-loading" role="status">
          Wedstrijddata laden…
        </div>
      );
    return (
      <Shell>
        <div className="app-state" role="status">
          <span className="brand-mark brand-mark--lg" role="img" aria-label="Apolloon" />
          <p>Wedstrijddata laden…</p>
        </div>
      </Shell>
    );
  }

  if (displayRoute)
    return (
      <>
        <ConnectionBanner />
        <Outlet />
      </>
    );

  return (
    <Shell>
      <a className="skip-link" href="#workspace">
        Naar inhoud
      </a>
      <AppShellFrame>
        <main id="workspace" className="workspace" tabIndex={-1}>
          <Outlet />
        </main>
      </AppShellFrame>
    </Shell>
  );
}

export function HomePage() {
  return <RolePicker />;
}

export function QueuePage() {
  const { race, runners } = useAppData(selectQueuePageData);
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);
  const waitingCount = runners.filter((runner) => runner.status === 'waiting').length;

  return (
    <>
      <PageHeader title="Wachtrij" actions={<QueueActions onOpenProfile={setProfileRunnerId} />} />
      <section className="race-strip" aria-label="Wisselzone">
        <div className="race-strip__now">
          <span className="race-strip__label">Nu op de piste</span>
          <span className="race-strip__runner">
            {activeRunner ? <RunnerName runner={activeRunner} /> : 'Nog niemand gestart'}
          </span>
          {race.activeStartedAt && activeRunner && (
            <LiveDuration
              startedAt={race.activeStartedAt}
              className="race-strip__time"
              refreshMs={1_000}
              format="seconds"
            />
          )}
        </div>
        <div>
          <span className="race-strip__label">Volgende</span>
          <span className="race-strip__runner">
            {nextRunner ? <RunnerName runner={nextRunner} /> : 'Niemand klaar'}
          </span>
        </div>
        <div>
          <span className="race-strip__label">Klaar om te lopen</span>
          <span className="race-strip__runner">
            {waitingCount} {waitingCount === 1 ? 'loper' : 'lopers'}
          </span>
        </div>
      </section>
      <KanbanBoard onOpenProfile={setProfileRunnerId} />
      {profileRunnerId && <RunnerProfileModal runnerId={profileRunnerId} onClose={() => setProfileRunnerId(null)} />}
    </>
  );
}

export function TimingPage() {
  return <TimingView />;
}

export function AnalysisPage() {
  return (
    <RouteLoadBoundary loadingMessage="Analyse wordt geladen...">
      <LazyAnalysisView />
    </RouteLoadBoundary>
  );
}

export function KobeTacticsPage() {
  return (
    <RouteLoadBoundary loadingMessage="Kobe's tactiek wordt geladen...">
      <LazyKobeTacticsView />
    </RouteLoadBoundary>
  );
}

export function AdminPage() {
  return (
    <RouteLoadBoundary loadingMessage="Admin wordt geladen...">
      <LazyAdminView />
    </RouteLoadBoundary>
  );
}

export function OutsideDisplayPage() {
  return (
    <RouteLoadBoundary loadingMessage="Buitenscherm wordt geladen..." displayMode>
      <LazyOutsideDisplay />
    </RouteLoadBoundary>
  );
}

export function InsideDisplayPage() {
  return (
    <RouteLoadBoundary loadingMessage="Binnenscherm wordt geladen..." displayMode>
      <LazyInsideDisplay />
    </RouteLoadBoundary>
  );
}

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="app-state">
      <h1>Deze pagina bestaat niet</h1>
      <p>Kies een werkplek op de startpagina.</p>
      <button className="btn btn--primary" onClick={() => void navigate({ to: '/' })}>
        Naar start
      </button>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-root">
      <ConnectionBanner />
      {children}
    </div>
  );
}

function ConnectionBanner() {
  const connectionLost = useConnectionLost();
  if (!connectionLost) return null;
  return (
    <div className="connection-banner" role="alert">
      <strong>Verbinding met de server verbroken.</strong> Live gegevens kunnen verouderd zijn. Er wordt opnieuw
      verbonden…
    </div>
  );
}

function RouteLoadBoundary({
  children,
  loadingMessage,
  displayMode = false,
}: {
  children: React.ReactNode;
  loadingMessage: string;
  displayMode?: boolean;
}) {
  const fallback = (
    <div className={displayMode ? 'display-loading' : 'app-state app-state--inline'} role="status">
      <p>{loadingMessage}</p>
    </div>
  );
  return <React.Suspense fallback={fallback}>{children}</React.Suspense>;
}

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
  items: ReadonlyArray<{ path: NavigationPath; label: string; icon: IconName; preload?: () => void }>;
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
      { path: '/analysis', label: 'Analyse', icon: 'analysis', preload: preloadAnalysisView },
      { path: '/tactics', label: "Kobe's tactiek", icon: 'tactics', preload: preloadKobeTacticsView },
    ],
  },
  {
    title: 'Publieksschermen',
    items: [
      { path: '/display/inside', label: 'Binnenscherm', icon: 'displayInside', preload: preloadDisplayViews },
      { path: '/display/outside', label: 'Buitenscherm', icon: 'displayOutside', preload: preloadDisplayViews },
    ],
  },
  { title: 'Systeem', items: [{ path: '/admin', label: 'Beheer', icon: 'admin', preload: preloadAdminView }] },
];

function AppShellFrame({ children }: { children: React.ReactNode }) {
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  return (
    <div className={`app-shell${collapsed ? ' is-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={toggleCollapsed} />
      {children}
    </div>
  );
}

function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

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
                  onPointerEnter={navigationItem.preload}
                  onFocus={navigationItem.preload}
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
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  );
}

/** Quiet when healthy; a coloured row with the reason when something needs attention. */
function SystemStatusRow() {
  const { cluster, error } = useClusterStatus();
  const status = deriveSystemStatus(cluster, error);
  if (!status) return null;
  return (
    <Link
      to="/admin"
      className={`system-status system-status--${status.tone}`}
      title={`${status.title}: ${status.detail}. Open Beheer voor details.`}
      onPointerEnter={preloadAdminView}
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
