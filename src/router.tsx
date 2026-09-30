import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router';
import { AppRoot, NotFoundPage } from './App';
import { clusterStatusQuery, queryClient, raceHistoryQuery, registrationsQuery } from './app/index';
import { bundledReferenceQuery } from './app/bundledReference';
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

/**
 * Fetches what a page shows before it opens, so it does not jump when its data lands.
 * Hovering a link already starts this; a click waits at most a moment, then the page
 * opens anyway and fills in. prefetchQuery never throws, so a failing request cannot block a page.
 */
function prefetch(...queries: Array<() => Promise<void>>) {
  return () =>
    Promise.race([
      Promise.all(queries.map((query) => query())),
      new Promise((resolve) => setTimeout(resolve, 300)),
    ]).then(() => undefined);
}

const recentLaps = (limit: number) => () => queryClient.prefetchQuery(raceHistoryQuery({ scope: 'recent', limit }));
const allLaps = () => queryClient.prefetchQuery(raceHistoryQuery());
const clusterStatus = () => queryClient.prefetchQuery(clusterStatusQuery);
const registrations = () => queryClient.prefetchQuery(registrationsQuery);
const bundledReference = () => queryClient.prefetchQuery(bundledReferenceQuery);

const rootRoute = createRootRoute({
  component: AppRoot,
  notFoundComponent: NotFoundPage,
});

// Wedstrijd screens load eagerly so operators never wait on a chunk; the rest splits.
const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    loader: prefetch(recentLaps(8), clusterStatus),
    component: RolePicker,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/queue',
    loader: prefetch(registrations),
    component: QueuePage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/timing',
    loader: prefetch(recentLaps(10), clusterStatus),
    component: TimingView,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/analysis',
    loader: prefetch(allLaps),
    component: lazyRouteComponent(() => import('./components/AnalysisView'), 'AnalysisView'),
    pendingComponent: pending('Analyse wordt geladen...'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/tactics',
    loader: prefetch(allLaps, bundledReference),
    component: lazyRouteComponent(() => import('./components/TacticsView'), 'TacticsView'),
    pendingComponent: pending('Tactiek wordt geladen...'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin',
    loader: prefetch(clusterStatus),
    component: lazyRouteComponent(() => import('./components/AdminView'), 'AdminView'),
    pendingComponent: pending('Beheer wordt geladen...'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/display/outside',
    loader: prefetch(allLaps),
    component: lazyRouteComponent(() => import('./components/DisplayViews'), 'OutsideDisplay'),
    pendingComponent: pending('Buitenscherm wordt geladen...', true),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/display/inside',
    loader: prefetch(allLaps),
    component: lazyRouteComponent(() => import('./components/DisplayViews'), 'InsideDisplay'),
    pendingComponent: pending('Binnenscherm wordt geladen...', true),
  }),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  // Loaders only fill the query cache, which decides for itself what is fresh.
  defaultPreloadStaleTime: 0,
  defaultErrorComponent: RouteErrorPage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
