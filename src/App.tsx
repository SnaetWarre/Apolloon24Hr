import React from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAppData, useClusterStatus, useConnectionLost, useDisconnected, useRealtimeBridge } from './app/index';
import { clusterStatusKey } from './app/snapshot';
import { useFailover } from './app/useFailover';
import { setDocumentSurface } from './app/theme';
import { AppShellFrame } from './components/Sidebar';
import type { ClusterStatus } from './types';

const selectNothing = () => ({});

export function AppRoot() {
  const { initialized, error, refresh } = useAppData(selectNothing);
  useRealtimeBridge(initialized);
  const connectionLost = useConnectionLost();
  const disconnected = useDisconnected();
  // useFailover waits a few seconds, so the first connection being made never counts as a failure.
  const switching = useFailover((initialized && disconnected) || Boolean(error));
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const displayRoute = pathname.startsWith('/display/');

  React.useLayoutEffect(() => {
    setDocumentSurface(displayRoute ? 'display' : 'operator');
  }, [displayRoute]);

  if (error) {
    return (
      <Shell switching={switching}>
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
          <p>Wedstrijddata laden…</p>
        </div>
      );
    return (
      <Shell switching={switching}>
        <div className="app-state" role="status">
          <span className="brand-mark brand-mark--lg" role="img" aria-label="Apolloon" />
          <p>Wedstrijddata laden…</p>
        </div>
      </Shell>
    );
  }

  if (displayRoute) {
    return (
      <>
        <ConnectionBanner connectionLost={connectionLost} switching={switching} />
        <Outlet />
      </>
    );
  }

  return (
    <Shell switching={switching}>
      <GroupProblemBanner />
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

function Shell({ children, switching }: { children: React.ReactNode; switching: boolean }) {
  const connectionLost = useConnectionLost();
  return (
    <div className="app-root">
      <ConnectionBanner connectionLost={connectionLost} switching={switching} />
      {children}
    </div>
  );
}

/** Offers the other laptops this browser last heard about, and says when it is switching to one. */
function ConnectionBanner({ connectionLost, switching }: { connectionLost: boolean; switching: boolean }) {
  const cluster = useQueryClient().getQueryData<ClusterStatus>(clusterStatusKey);
  if (!connectionLost && !switching) return null;
  if (switching) {
    return (
      <div className="connection-banner" role="alert">
        <strong>Verbinding met deze laptop verbroken.</strong> Overschakelen naar een andere laptop…
      </div>
    );
  }
  const alternatives = (cluster?.memberUrls ?? []).filter((url) => url !== window.location.origin);
  return (
    <div className="connection-banner" role="alert">
      <strong>Verbinding met de server verbroken.</strong> Live gegevens kunnen verouderd zijn. Er wordt opnieuw
      verbonden…
      {alternatives.length > 0 && (
        <>
          {' '}
          Andere laptop:{' '}
          {alternatives.map((url, index) => (
            <React.Fragment key={url}>
              {index > 0 && ', '}
              <a href={`${url}${window.location.pathname}`}>{url.replace(/^https?:\/\//, '')}</a>
            </React.Fragment>
          ))}
        </>
      )}
    </div>
  );
}

/** Says so on every screen when changes cannot be saved, because too few laptops are reachable. */
function GroupProblemBanner() {
  const { cluster } = useClusterStatus();
  if (cluster?.state !== 'no-majority') return null;
  return (
    <div className="group-banner" role="alert">
      <strong>Te weinig laptops bereikbaar.</strong> Je ziet de laatste gegevens, maar wijzigingen worden pas weer
      bewaard als een tweede laptop terug is. Zet die aan of controleer de netwerkkabel.
    </div>
  );
}
