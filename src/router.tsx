import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import {
  AdminPage,
  AnalysisPage,
  AppRoot,
  HomePage,
  InsideDisplayPage,
  NotFoundPage,
  OutsideDisplayPage,
  QueuePage,
  TimingPage,
} from './App';

const rootRoute = createRootRoute({
  component: AppRoot,
  notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/queue',
  component: QueuePage,
});

const timingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/timing',
  component: TimingPage,
});

const analysisRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analysis',
  component: AnalysisPage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminPage,
});

const outsideDisplayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/display/outside',
  component: OutsideDisplayPage,
});

const insideDisplayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/display/inside',
  component: InsideDisplayPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  queueRoute,
  timingRoute,
  analysisRoute,
  adminRoute,
  outsideDisplayRoute,
  insideDisplayRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
