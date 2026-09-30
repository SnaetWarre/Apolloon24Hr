import React from 'react';
import { useRouter, useRouterState, type ErrorComponentProps } from '@tanstack/react-router';

/** Public displays run without anyone next to them, so they try again by themselves. */
const DISPLAY_RETRY_MS = 15_000;

/**
 * Sends what went wrong to the laptop's `server.log`, so the cause can be found after the
 * event. Reporting must never fail the screen, so every error here is swallowed.
 */
export function reportClientError(error: unknown, componentStack?: string) {
  const payload = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    componentStack,
    path: window.location.pathname,
  };
  void fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => undefined);
}

/**
 * Shown in place of a page that failed. The sidebar stays, so the operator can go on
 * elsewhere; the race data lives on the server and is not affected.
 */
export function RouteErrorPage({ error, info, reset }: ErrorComponentProps) {
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const displayRoute = pathname.startsWith('/display/');

  React.useEffect(() => {
    reportClientError(error, info?.componentStack);
  }, [error, info]);

  const retry = React.useCallback(() => {
    // A rejected module import stays cached until the document is reloaded.
    if (displayRoute) {
      window.location.reload();
      return;
    }
    reset();
    void router.invalidate();
  }, [displayRoute, reset, router]);

  React.useEffect(() => {
    if (!displayRoute) return;
    const timer = window.setTimeout(retry, DISPLAY_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [displayRoute, retry]);

  if (displayRoute) {
    return (
      <div className="display-loading" role="alert">
        Scherm wordt opnieuw geladen…
      </div>
    );
  }

  return <ErrorState error={error} onRetry={retry} />;
}

type BoundaryState = { error: unknown };

/**
 * Last line of defence around the whole app, for a failure outside any page (the
 * sidebar, a dialog). Without it React leaves an empty window.
 */
export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    reportClientError(error, info.componentStack ?? undefined);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return <ErrorState error={this.state.error} onRetry={() => this.setState({ error: null })} />;
  }
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="app-state" role="alert">
      <span className="brand-mark brand-mark--lg" role="img" aria-label="Apolloon" />
      <h1>Dit scherm liep vast</h1>
      <p>
        De wedstrijdgegevens zijn veilig: ze staan op de server, niet in dit scherm. Probeer opnieuw; lukt dat niet,
        herlaad dan de pagina.
      </p>
      <div className="form-row form-row--plain">
        <button className="btn btn--primary" onClick={onRetry}>
          Opnieuw proberen
        </button>
        <button className="btn btn--secondary" onClick={() => window.location.reload()}>
          Pagina herladen
        </button>
      </div>
      <details className="error-details">
        <summary className="disclosure">Technische details</summary>
        <pre>{message}</pre>
      </details>
    </div>
  );
}
