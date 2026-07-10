import React from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { RolePicker } from './components/RolePicker';
import { useAppData, useRealtimeBridge } from './app/index';
import { formatDurationMs, nowMs } from './lib/time';
import { getNextWaitingRunner, runnerLabel } from './lib/runners';
import { useAnimationFrameTick } from './lib/useAnimationFrameTick';

const AnalysisView = React.lazy(async () => {
  const module = await import('./components/AnalysisView');
  return { default: module.AnalysisView };
});

const AppHeader = React.lazy(async () => {
  const module = await import('./components/AppHeader');
  return { default: module.AppHeader };
});

const AdminView = React.lazy(async () => {
  const module = await import('./components/AdminView');
  return { default: module.AdminView };
});

const InsideDisplay = React.lazy(async () => {
  const module = await import('./components/DisplayViews');
  return { default: module.InsideDisplay };
});

const OutsideDisplay = React.lazy(async () => {
  const module = await import('./components/DisplayViews');
  return { default: module.OutsideDisplay };
});

const KanbanBoard = React.lazy(async () => {
  const module = await import('./components/KanbanBoard');
  return { default: module.KanbanBoard };
});

const RunnerProfileModal = React.lazy(async () => {
  const module = await import('./components/RunnerProfileModal');
  return { default: module.RunnerProfileModal };
});

const TimingView = React.lazy(async () => {
  const module = await import('./components/TimingView');
  return { default: module.TimingView };
});

export function AppRoot() {
  useRealtimeBridge();
  const { initialized, error, refresh } = useAppData();
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

  const outlet = (
    <React.Suspense
      fallback={
        <div className="empty-state">
          <h1>Apolloon telsysteem</h1>
          <p>Pagina wordt geladen...</p>
        </div>
      }
    >
      <Outlet />
    </React.Suspense>
  );

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
  const { race, runners } = useAppData();
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner = getNextWaitingRunner(runners);

  useAnimationFrameTick(Boolean(race.activeStartedAt));

  return (
    <>
      <div className="hero hero--compact">
        <div>
          <img className="hero-logo" src="/brand/apolloon-logo.png" alt="Apolloon" />
          <h1 className="app-title">Apolloon telsysteem</h1>
          <p className="tagline">Telsysteem 1 - wachtrij en wisselzone</p>
        </div>
      </div>
      <div className="race-strip">
        <div>
          <span className="muted-label">Nu op de piste</span>
          <strong>{activeRunner ? runnerLabel(activeRunner) : 'Nog niemand gestart'}</strong>
          {race.activeStartedAt && <span>{formatDurationMs(nowMs() - race.activeStartedAt)}</span>}
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
  return <AnalysisView />;
}

export function AdminPage() {
  return <AdminView />;
}

export function OutsideDisplayPage() {
  const navigate = useNavigate();
  return <OutsideDisplay onNavigate={(path) => void navigate({ to: path as never })} />;
}

export function InsideDisplayPage() {
  const navigate = useNavigate();
  return <InsideDisplay onNavigate={(path) => void navigate({ to: path as never })} />;
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

function TopNav() {
  const navigate = useNavigate();
  return (
    <nav className="top-nav">
      <button className="nav-link" onClick={() => void navigate({ to: '/' })}>
        Start
      </button>
      <button className="nav-link" onClick={() => void navigate({ to: '/queue' })}>
        Telsysteem 1
      </button>
      <button className="nav-link" onClick={() => void navigate({ to: '/timing' })}>
        Telsysteem 2
      </button>
      <button className="nav-link" onClick={() => void navigate({ to: '/analysis' })}>
        Analyse
      </button>
      <button className="nav-link" onClick={() => void navigate({ to: '/admin' })}>
        Admin
      </button>
    </nav>
  );
}
