import React from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAppData, useClusterStatus, useConnectionLost, useRealtimeBridge } from './app/index';
import { clusterStatusKey } from './app/snapshot';
import { setDocumentSurface } from './app/theme';
import { AppShellFrame } from './components/Sidebar';
import type { ClusterStatus } from './types';

const selectNothing = () => ({});

export function AppRoot() {
  const { initialized, error, refresh } = useAppData(selectNothing);
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

  if (displayRoute) {
    return (
      <>
        <ConnectionBanner />
        <Outlet />
      </>
    );
  }

  return (
    <Shell>
      <StandbyBanner />
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-root">
      <ConnectionBanner />
      {children}
    </div>
  );
}

/** Offers the other laptops this browser last heard about, so operators can switch after a failure. */
function ConnectionBanner() {
  const connectionLost = useConnectionLost();
  const cluster = useQueryClient().getQueryData<ClusterStatus>(clusterStatusKey);
  if (!connectionLost) return null;
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

function StandbyBanner() {
  const { cluster } = useClusterStatus();
  if (cluster?.role !== 'standby') return null;
  const primaryUrl = cluster.primary?.url;
  return (
    <div className="standby-banner" role="status">
      <strong>Standby, alleen-lezen.</strong> Wijzigingen gebeuren op de primaire laptop
      {primaryUrl ? (
        <>
          : <a href={`${primaryUrl}${window.location.pathname}`}>{primaryUrl.replace(/^https?:\/\//, '')}</a>
        </>
      ) : null}
      . Valt die uit, neem dan over in Beheer › Systeem.
    </div>
  );
}
