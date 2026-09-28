import React from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { AppHeader } from './components/AppHeader';
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
  preloadKobeTacticsView,
} from './lazyViews';
import { getNextWaitingRunner } from './lib/runners';
import { LiveDuration, LiveElapsed } from './components/LiveTime';
import { RunnerName } from './components/RunnerName';
import { ThemeSwitch } from './components/ThemeSwitch';
import { setDocumentSurface } from './app/theme';
import { deriveSystemStatus } from './lib/systemStatus';
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
    if (displayRoute) return <div className="display-loading" role="status">Wedstrijddata laden…</div>;
    return (
      <Shell>
        <div className="app-state" role="status">
          <span className="brand-mark brand-mark--lg" role="img" aria-label="Apolloon" />
          <p>Wedstrijddata laden…</p>
        </div>
      </Shell>
    );
  }

  if (displayRoute) return (<><ConnectionBanner /><Outlet /></>);

  return (
    <Shell>
      <a className="skip-link" href="#workspace">Naar inhoud</a>
      <TopBar />
      <main id="workspace" className="workspace" tabIndex={-1}><Outlet /></main>
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
      <h1 className="visually-hidden">Wachtrij en wisselzone</h1>
      <section className="race-strip" aria-label="Wisselzone">
        <div className="race-strip__now">
          <span className="race-strip__label">Nu op de piste</span>
          <span className="race-strip__runner">
            {activeRunner ? <RunnerName runner={activeRunner} /> : 'Nog niemand gestart'}
          </span>
          {race.activeStartedAt && activeRunner && (
            <LiveDuration startedAt={race.activeStartedAt} className="race-strip__time" refreshMs={1_000} format="seconds" />
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
          <span className="race-strip__runner">{waitingCount} {waitingCount === 1 ? 'loper' : 'lopers'}</span>
        </div>
      </section>
      <AppHeader
        onOpenProfile={(runnerId) => {
          setProfileRunnerId(runnerId);
        }}
      />
      <KanbanBoard onOpenProfile={setProfileRunnerId} />
      {profileRunnerId && (
        <RunnerProfileModal runnerId={profileRunnerId} onClose={() => setProfileRunnerId(null)} />
      )}
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
      <strong>Verbinding met de server verbroken.</strong> Live gegevens kunnen verouderd zijn. Er wordt opnieuw verbonden…
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

const NAVIGATION_ITEMS: ReadonlyArray<{
  path: '/' | '/queue' | '/timing' | '/analysis' | '/tactics' | '/admin';
  label: string;
  preload?: () => void;
}> = [
  { path: '/', label: 'Start' },
  { path: '/queue', label: 'Wachtrij' },
  { path: '/timing', label: 'Timing' },
  { path: '/analysis', label: 'Analyse', preload: preloadAnalysisView },
  { path: '/tactics', label: "Kobe's tactiek", preload: preloadKobeTacticsView },
  { path: '/admin', label: 'Beheer', preload: preloadAdminView },
];

function TopBar() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <header className="top-bar">
      <Link className="top-bar__brand" to="/" aria-label="Apolloon, naar de startpagina">
        <span className="brand-mark" aria-hidden="true" />
      </Link>
      <nav className="top-bar__nav" aria-label="Hoofdnavigatie">
        {NAVIGATION_ITEMS.map((navigationItem) => {
          const isCurrentPage = pathname === navigationItem.path;
          return (
            <Link
              key={navigationItem.path}
              className="nav-link"
              aria-current={isCurrentPage ? 'page' : undefined}
              onPointerEnter={navigationItem.preload}
              onFocus={navigationItem.preload}
              to={navigationItem.path}
            >
              {navigationItem.label}
            </Link>
          );
        })}
      </nav>
      <div className="top-bar__status">
        <RaceClock />
        <SystemStatusChip />
        <ThemeSwitch />
      </div>
    </header>
  );
}

const selectRaceClockData = ({ race }: LiveAppSnapshot) => ({ race });

function RaceClock() {
  const { race } = useAppData(selectRaceClockData);
  if (!race.raceStartedAt) return <span className="status-chip status-chip--plain">Race niet gestart</span>;
  if (race.raceFinishedAt) return <span className="status-chip status-chip--plain">Race afgesloten</span>;
  return (
    <span className="status-chip status-chip--plain" title="Tijd sinds de start van de race">
      Race <strong><LiveElapsed startedAt={race.raceStartedAt} /></strong>
    </span>
  );
}

function SystemStatusChip() {
  const { cluster, error } = useClusterStatus();
  const status = deriveSystemStatus(cluster, error);
  if (!status) return null;
  return (
    <Link
      to="/admin"
      className={`status-chip status-chip--${status.tone}`}
      title={`${status.title}: ${status.detail}. Open Beheer voor details.`}
      onPointerEnter={preloadAdminView}
    >
      <span className="status-chip__dot" aria-hidden="true" />
      <span role={status.tone === 'error' ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">
        <strong>{status.title}</strong>
        <span className="status-chip__detail"> {status.detail}</span>
      </span>
    </Link>
  );
}
