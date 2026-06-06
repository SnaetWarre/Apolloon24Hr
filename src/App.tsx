import React from 'react';
import { AppHeader } from './components/AppHeader';
import { AnalysisView } from './components/AnalysisView';
import { AdminView } from './components/AdminView';
import { InsideDisplay, OutsideDisplay } from './components/DisplayViews';
import { KanbanBoard } from './components/KanbanBoard';
import { RolePicker } from './components/RolePicker';
import { RunnerProfileModal } from './components/RunnerProfileModal';
import { TimingView } from './components/TimingView';
import { useAppStore } from './store';
import { formatDurationMs, nowMs } from './lib/time';
import { useAnimationFrameTick } from './lib/useAnimationFrameTick';

export const App: React.FC = () => {
  const initialize = useAppStore((state) => state.initialize);
  const initialized = useAppStore((state) => state.initialized);
  const [path, setPath] = React.useState(() => window.location.pathname);
  const [initError, setInitError] = React.useState<string | null>(null);

  React.useEffect(() => {
    initialize().catch((err) => {
      setInitError(err instanceof Error ? err.message : 'Opstarten mislukt');
    });
  }, [initialize]);

  React.useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function navigate(nextPath: string) {
    window.history.pushState(null, '', nextPath);
    setPath(nextPath);
  }

  if (initError) {
    return (
      <Shell>
        <div className="empty-state">
          <h1>Kan niet verbinden met de lokale server</h1>
          <p>{initError}</p>
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

  if (path === '/display/outside') return <OutsideDisplay onNavigate={navigate} />;
  if (path === '/display/inside') return <InsideDisplay onNavigate={navigate} />;

  return (
    <Shell>
      {path !== '/' && <TopNav onNavigate={navigate} />}
      {path === '/' && <RolePicker onNavigate={navigate} />}
      {path === '/queue' && <QueuePage />}
      {path === '/timing' && <TimingView />}
      {path === '/analysis' && <AnalysisView />}
      {path === '/admin' && <AdminView />}
      {!['/', '/queue', '/timing', '/analysis', '/admin'].includes(path) && (
        <div className="empty-state">
          <h1>Onbekende pagina</h1>
          <button className="btn btn--primary" onClick={() => navigate('/')}>
            Terug naar start
          </button>
        </div>
      )}
    </Shell>
  );
};

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="app-root">{children}</div>;
}

function TopNav({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <nav className="top-nav">
      <button className="nav-link" onClick={() => onNavigate('/')}>
        Start
      </button>
      <button className="nav-link" onClick={() => onNavigate('/queue')}>
        Telsysteem 1
      </button>
      <button className="nav-link" onClick={() => onNavigate('/timing')}>
        Telsysteem 2
      </button>
      <button className="nav-link" onClick={() => onNavigate('/analysis')}>
        Analyse
      </button>
      <button className="nav-link" onClick={() => onNavigate('/admin')}>
        Admin
      </button>
    </nav>
  );
}

function QueuePage() {
  const race = useAppStore((state) => state.race);
  const runners = useAppStore((state) => state.runners);
  const [profileRunnerId, setProfileRunnerId] = React.useState<string | null>(null);

  const activeRunner = runners.find((runner) => runner.id === race.activeRunnerId) || null;
  const nextRunner =
    runners
      .filter((runner) => runner.status === 'waiting')
      .sort((a, b) => (a.queueIndex ?? 0) - (b.queueIndex ?? 0))[0] || null;

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

function runnerLabel(runner: { runnerNumber: string | null; name: string }) {
  return runner.runnerNumber ? `${runner.runnerNumber} - ${runner.name}` : runner.name;
}
