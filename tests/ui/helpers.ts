import type { Page } from '@playwright/test';

export async function openSeededRoute(page: Page, route: string, readySelector: string) {
  const stateResponse = await page.request.get('/api/state');
  const state = (await stateResponse.json()) as { serverNowMs: number };
  await page.clock.setFixedTime(state.serverNowMs);
  await page.goto(route);
  await page.locator(readySelector).first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
}

export async function documentHasHorizontalOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
}
