import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router';
import { AppRoot, NotFoundPage } from './App';
import { RouteErrorPage } from './components/ErrorScreens';
import { QueuePage } from './components/QueuePage';
import { RolePicker } from './components/RolePicker';
import { TimingView } from './components/TimingView';

function pending(message: string, display = false) {
  return function PendingRoute() {
    return (
      <div className={display ? 'display-loading' : 'app-state app-state--inline'} role="status">
        <p>{message}</p>
      </div>
    );
  };
}

const rootRoute = createRootRoute({
  component: AppRoot,
  notFoundComponent: NotFoundPage,
});

// Wedstrijd screens load eagerly so operators never wait on a chunk; the rest splits.
const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: RolePicker,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/queue',
    component: QueuePage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/timing',
    component: TimingView,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/analysis',
    component: lazyRouteComponent(() => import('./components/AnalysisView'), 'AnalysisView'),
    pendingComponent: pending('Analyse wordt geladen...'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/tactics',
    component: lazyRouteComponent(() => import('./components/TacticsView'), 'TacticsView'),
    pendingComponent: pending('Tactiek wordt geladen...'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin',
    component: lazyRouteComponent(() => import('./components/AdminView'), 'AdminView'),
    pendingComponent: pending('Beheer wordt geladen...'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/display/outside',
    component: lazyRouteComponent(() => import('./components/DisplayViews'), 'OutsideDisplay'),
    pendingComponent: pending('Buitenscherm wordt geladen...', true),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/display/inside',
    component: lazyRouteComponent(() => import('./components/DisplayViews'), 'InsideDisplay'),
    pendingComponent: pending('Binnenscherm wordt geladen...', true),
  }),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent', defaultErrorComponent: RouteErrorPage });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
