import React from 'react';

const loadAdminView = () => import('./components/AdminView');
const loadAnalysisView = () => import('./components/AnalysisView');
const loadDisplayViews = () => import('./components/DisplayViews');

export const LazyAdminView = React.lazy(async () => {
  const adminViewModule = await loadAdminView();
  return { default: adminViewModule.AdminView };
});

export const LazyAnalysisView = React.lazy(async () => {
  const analysisViewModule = await loadAnalysisView();
  return { default: analysisViewModule.AnalysisView };
});

export const LazyInsideDisplay = React.lazy(async () => {
  const displayViewsModule = await loadDisplayViews();
  return { default: displayViewsModule.InsideDisplay };
});

export const LazyOutsideDisplay = React.lazy(async () => {
  const displayViewsModule = await loadDisplayViews();
  return { default: displayViewsModule.OutsideDisplay };
});

export function preloadAdminView(): void {
  void loadAdminView();
}

export function preloadAnalysisView(): void {
  void loadAnalysisView();
}

export function preloadDisplayViews(): void {
  void loadDisplayViews();
}
