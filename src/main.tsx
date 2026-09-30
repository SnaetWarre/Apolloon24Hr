import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { queryClient } from './app/index';
import { ConfirmProvider } from './components/ConfirmDialog';
import { DesktopTitleBar } from './components/DesktopTitleBar';
import { AppErrorBoundary, reportClientError } from './components/ErrorScreens';
import { getDesktop } from './lib/desktop';
import { router } from './router';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found');
}
const root = createRoot(container);
const desktop = getDesktop();
const app = (
  <AppErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <RouterProvider router={router} />
      </ConfirmProvider>
    </QueryClientProvider>
  </AppErrorBoundary>
);

// Errors outside rendering (timers, event handlers, promises) do not reach an error boundary.
window.addEventListener('error', (event) => reportClientError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => reportClientError(event.reason));
root.render(
  <React.StrictMode>
    {desktop ? (
      <>
        <DesktopTitleBar bridge={desktop} onHome={() => void router.navigate({ to: '/' })} />
        <div className="desktop-page">{app}</div>
      </>
    ) : (
      app
    )}
  </React.StrictMode>
);
