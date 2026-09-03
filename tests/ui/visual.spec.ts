import { expect, test } from '@playwright/test';
import { openSeededRoute } from './helpers';

const operatorRoutes = [
  { name: 'start', path: '/', readySelector: '.role-sections' },
  { name: 'queue', path: '/queue', readySelector: '.kanban' },
  { name: 'timing', path: '/timing', readySelector: '.timing-actions' },
  { name: 'analysis', path: '/analysis', readySelector: '.analysis-top-grid' },
  { name: 'admin', path: '/admin', readySelector: '.admin-dashboard__backup' },
] as const;

for (const operatorRoute of operatorRoutes) {
  test(`${operatorRoute.name} matches its seeded visual baseline`, async ({ page }) => {
    await openSeededRoute(page, operatorRoute.path, operatorRoute.readySelector);
    await expect(page).toHaveScreenshot(`${operatorRoute.name}.png`, { fullPage: true });
  });
}

test.describe('public displays', () => {
  test.skip(({ viewport }) => viewport?.width !== 1440);

  test('outside display matches its seeded 16:9 baseline', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openSeededRoute(page, '/display/outside', '.display-root--outside');
    await expect(page).toHaveScreenshot('outside-display.png');
  });

  test('inside display matches its seeded presentation baseline', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await openSeededRoute(page, '/display/inside', '.display-root--inside');
    await expect(page).toHaveScreenshot('inside-display.png');
  });
});
