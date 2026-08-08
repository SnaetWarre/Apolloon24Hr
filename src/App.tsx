import React from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { AppHeader } from './components/AppHeader';
import { KanbanBoard } from './components/KanbanBoard';
import { RolePicker } from './components/RolePicker';
import { RunnerProfileModal } from './components/RunnerProfileModal';
import { TimingView } from './components/TimingView';
import { useAppData, useRealtimeBridge } from './app/index';
import {
  LazyAdminView,
  LazyAnalysisView,
  LazyInsideDisplay,
  LazyOutsideDisplay,
  preloadAdminView,
  preloadAnalysisView,
} from './lazyViews';
import { getNextWaitingRunner, runnerLabel } from './lib/runners';
import { LiveDuration } from './components/LiveTime';
import type { LiveAppSnapshot } from './types';

const selectConnectionData = () => ({});
const selectQueuePageData = ({ race, runners }: LiveAppSnapshot) => ({ race, runners });

export function AppRoot() {
  const { initialized, error, refresh } = useAppData(selectConnectionData);
  useRealtimeBridge(initialized);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const displayRoute = pathname.startsWith('/display/');

  if (error) {
    return (
      <Shell>
        <div className="empty-state">
          <h1>Kan niet verbinden met de lokale server</h1>
          <p>{error.message}</p>
          <button className="btn btn--primary" onClick={() => void refresh()}>
            Opnieuw proberen
          </button>
        </div>
      </Shell>
    );
  }

  if (!initialized) {
    return (
      <Shell>
        <div className="empty-state">
          <h1>Apolloon telsysteem</h1>
          <p>Lokale data wordt geladen...</p>
        </div>
      </Shell>
    );
  }

  const outlet = <Outlet />;

  if (displayRoute) return outlet;

  return (
    <Shell>
      {pathname !== '/' && <TopNav />}
      {outlet}
    </Shell>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  return <RolePicker onNavigate={(path) => void navigate({ to: path as never })} />;
}

export function QueuePage() {
  const { race, runners } = useAppData(selectQueuePageData);
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);

  return (
    <>
      <div className="hero hero--compact">
        <div>
          <span className="page-kicker">Telsysteem 1</span>
          <h1 className="app-title">Apolloon telsysteem</h1>
          <p className="tagline">Telsysteem 1 - wachtrij en wisselzone</p>
        </div>
      </div>
      <div className="race-strip">
        <div>
          <span className="muted-label">Nu op de piste</span>
          <strong>{activeRunner ? runnerLabel(activeRunner) : 'Nog niemand gestart'}</strong>
          {race.activeStartedAt && <LiveDuration startedAt={race.activeStartedAt} />}
        </div>
        <div>
          <span className="muted-label">Volgende</span>
          <strong>{nextRunner ? runnerLabel(nextRunner) : 'Geen loper in wachtrij'}</strong>
        </div>
      </div>
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
    <div className="empty-state">
      <h1>Onbekende pagina</h1>
      <button className="btn btn--primary" onClick={() => void navigate({ to: '/' })}>
        Terug naar start
      </button>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="app-root">{children}</div>;
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
    <div className={displayMode ? 'display-loading' : 'empty-state'}>
      <p>{loadingMessage}</p>
    </div>
  );
  return <React.Suspense fallback={fallback}>{children}</React.Suspense>;
}

function TopNav() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigationItems: ReadonlyArray<{
    path: '/' | '/queue' | '/timing' | '/analysis' | '/admin';
    label: string;
    preload?: () => void;
  }> = [
    { path: '/', label: 'Start' },
    { path: '/queue', label: 'Telsysteem 1' },
    { path: '/timing', label: 'Telsysteem 2' },
    { path: '/analysis', label: 'Analyse', preload: preloadAnalysisView },
    { path: '/admin', label: 'Admin', preload: preloadAdminView },
  ];

  return (
    <nav className="top-nav" aria-label="Hoofdnavigatie">
      <button
        className="top-nav__brand"
        onClick={() => void navigate({ to: '/' })}
        aria-label="Naar de startpagina"
      >
        <span className="top-nav__logo">
          <img src="/brand/apolloon-logo.png" alt="" width={560} height={169} />
        </span>
        <span>Apolloon</span>
      </button>
      <div className="top-nav__links">
        {navigationItems.map((navigationItem) => {
          const isCurrentPage = pathname === navigationItem.path;
          return (
            <button
              key={navigationItem.path}
              className={`nav-link${isCurrentPage ? ' nav-link--active' : ''}`}
              aria-current={isCurrentPage ? 'page' : undefined}
              onPointerEnter={navigationItem.preload}
              onFocus={navigationItem.preload}
              onClick={() => void navigate({ to: navigationItem.path as never })}
            >
              {navigationItem.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
