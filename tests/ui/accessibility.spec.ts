import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { documentHasHorizontalOverflow, openSeededRoute } from './helpers';

const routes = [
  { path: '/', readySelector: '.role-sections' },
  { path: '/queue', readySelector: '.kanban' },
  { path: '/timing', readySelector: '.timing-actions' },
  { path: '/analysis', readySelector: '.analysis-top-grid' },
  { path: '/admin', readySelector: '.admin-dashboard__backup' },
  { path: '/display/outside', readySelector: '.display-root--outside' },
  { path: '/display/inside', readySelector: '.display-root--inside' },
] as const;

// Keep existing debt visible and fail on any unreviewed rule or affected element.
// Counts should only decrease in a PR that fixes and documents the corresponding UI.
const knownViolationCounts: Record<string, Record<string, number>> = {
  '/': {},
  '/queue': { 'color-contrast': 1 },
  '/timing': { 'color-contrast': 5 },
  '/analysis': { 'color-contrast': 31 },
  '/admin': { 'color-contrast': 14, label: 1, 'select-name': 1 },
  '/display/outside': {},
  '/display/inside': { 'color-contrast': 1 },
};

for (const route of routes) {
  test(`${route.path} does not exceed its reviewed WCAG A and AA baseline`, async ({ page }) => {
    await openSeededRoute(page, route.path, route.readySelector);
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const violationCounts = Object.fromEntries(
      audit.violations.map((violation) => [violation.id, violation.nodes.length])
    );
    expect(violationCounts).toEqual(knownViolationCounts[route.path]);
  });
}

test('operator navigation exposes a visible keyboard focus indicator', async ({ page }) => {
  await openSeededRoute(page, '/queue', '.kanban');
  await page.keyboard.press('Tab');
  const focusedControl = page.locator(':focus-visible');
  await expect(focusedControl).toBeVisible();
  expect(await focusedControl.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
});

test('operator routes do not overflow a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of routes.slice(0, 5)) {
    await openSeededRoute(page, route.path, route.readySelector);
    expect(await documentHasHorizontalOverflow(page), `${route.path} overflowed horizontally`).toBe(false);
  }
});

test('long runner names stay inside queue and display surfaces', async ({ page }) => {
  const longName = 'Alexandria Van den Broeck-Van der Velde met een uitzonderlijk lange lopersnaam';
  for (const route of [
    { path: '/queue', readySelector: '.runner-title', containerSelector: '.card-main' },
    { path: '/display/outside', readySelector: '.display-runner-name', containerSelector: '.outside-runner' },
    { path: '/display/inside', readySelector: '.recent-lap-runner > strong', containerSelector: '.recent-lap-runner' },
  ]) {
    await openSeededRoute(page, route.path, route.readySelector);
    const runnerName = page.locator(route.readySelector).first();
    await runnerName.evaluate((element, replacement) => { element.textContent = replacement; }, longName);
    const isContained = await runnerName.evaluate((element, containerSelector) => {
      const bounds = element.getBoundingClientRect();
      const containerBounds = element.closest(containerSelector)?.getBoundingClientRect();
      return Boolean(
        containerBounds &&
        bounds.left >= containerBounds.left &&
        bounds.right <= containerBounds.right &&
        bounds.right <= document.documentElement.clientWidth
      );
    }, route.containerSelector);
    expect(isContained, `${route.path} did not contain a long runner name`).toBe(true);
  }
});

test('reduced motion stops automatic inside-ranking rotation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openSeededRoute(page, '/display/inside', '.inside-ranking-modes');
  await expect(page.getByText('Automatisch wisselen is uitgeschakeld')).toBeVisible();
  const activeMode = page.locator('.inside-ranking-modes .is-active');
  const initialMode = await activeMode.textContent();
  await page.clock.runFor(16_000);
  await expect(activeMode).toHaveText(initialMode ?? 'Rondes');
});
