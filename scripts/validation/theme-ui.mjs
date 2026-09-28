// Run against a disposable, ready-seeded server, never an event database.
// Uses the same environment variables as workflow-ui.mjs.
import assert from 'node:assert/strict';

const baseUrl = process.env.APOLLOON_TEST_URL;
assert.ok(baseUrl && ['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'Use an explicitly configured disposable localhost server');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const snapshot = async () => (await fetch(`${baseUrl}/api/state`)).json();
const theme = (page) => page.evaluate(() => ({
  theme: document.documentElement.dataset.theme ?? null,
  stored: localStorage.getItem('apolloon.theme'),
  background: getComputedStyle(document.body).backgroundColor,
}));

try {
  // No flash: the inline script decides the theme before any application JavaScript runs.
  const blocked = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 720 } });
  const blockedPage = await blocked.newPage();
  await blockedPage.route('**/assets/*.js', (route) => route.abort());
  await blockedPage.goto(`${baseUrl}/timing`);
  const beforeApp = await theme(blockedPage);
  assert.equal(beforeApp.theme, 'dark');
  assert.equal(beforeApp.background, 'rgb(26, 26, 26)');
  await blocked.close();
  console.log('PASS without a stored choice the OS preference applies before the app loads');

  const context = await browser.newContext({ colorScheme: 'light', viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/`);
  const themeGroup = page.getByRole('radiogroup', { name: 'Thema' });
  await themeGroup.waitFor();
  assert.equal((await theme(page)).theme, 'light');
  await themeGroup.getByRole('radio', { name: 'Donker' }).click();
  assert.deepEqual(
    { theme: (await theme(page)).theme, stored: (await theme(page)).stored },
    { theme: 'dark', stored: 'dark' }
  );
  await page.getByRole('link', { name: 'Wachtrij', exact: true }).click();
  await page.getByRole('button', { name: 'Loper zoeken', exact: true }).waitFor();
  assert.equal((await theme(page)).theme, 'dark');
  await page.reload();
  await page.getByRole('button', { name: 'Loper zoeken', exact: true }).waitFor();
  assert.equal((await theme(page)).theme, 'dark');
  console.log('PASS explicit choice is stored per browser and survives navigation and reload');

  // Only Licht and Donker exist; a stored choice wins over the operating system.
  assert.equal(await themeGroup.getByRole('radio').count(), 2);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await page.getByRole('button', { name: 'Loper zoeken', exact: true }).waitFor();
  assert.equal((await theme(page)).theme, 'dark');
  console.log('PASS only Licht and Donker are offered and the stored choice beats the OS setting');

  // Arrow keys move within the group; Space on Timing stays the timing key.
  await page.goto(`${baseUrl}/timing`);
  const initialRace = await snapshot();
  assert.equal(initialRace.race.activeRunnerId, null, 'Requires a fresh ready seed');
  const lightRadio = page.getByRole('radiogroup', { name: 'Thema' }).getByRole('radio', { name: 'Licht' });
  await lightRadio.click();
  await page.keyboard.press('ArrowRight');
  assert.equal((await theme(page)).stored, 'dark');
  await page.keyboard.press('Space');
  for (let attempt = 0; attempt < 60 && !(await snapshot()).race.activeRunnerId; attempt++) {
    await page.waitForTimeout(50);
  }
  assert.ok((await snapshot()).race.activeRunnerId, 'Space should still start the next runner');
  assert.equal((await theme(page)).stored, 'dark', 'Space must not change the theme');
  console.log('PASS theme control supports arrow keys and never captures the timing key');

  // Record a few laps so Analyse has chart data.
  for (let lap = 1; lap <= 3; lap++) {
    await page.waitForTimeout(400);
    await page.keyboard.press('Space');
    await page.getByText(/Ronde opgeslagen/).waitFor();
  }

  // Charts redraw with new colours; the data stays the same.
  await page.goto(`${baseUrl}/analysis`);
  const trendCanvas = page.locator('.analysis-trend-panel canvas');
  await trendCanvas.waitFor();
  await page.waitForTimeout(300);
  const kpisBefore = await page.locator('.stats-grid--analysis').innerText();
  const pixelsBefore = await trendCanvas.evaluate((canvas) => canvas.toDataURL());
  await page.getByRole('radiogroup', { name: 'Thema' }).getByRole('radio', { name: 'Licht' }).click();
  await page.waitForTimeout(300);
  assert.notEqual(await trendCanvas.evaluate((canvas) => canvas.toDataURL()), pixelsBefore);
  assert.equal(await page.locator('.stats-grid--analysis').innerText(), kpisBefore);
  console.log('PASS charts redraw in the new theme without changing figures');

  // Public displays keep their own presentation regardless of the operator theme.
  await page.getByRole('radiogroup', { name: 'Thema' }).getByRole('radio', { name: 'Donker' }).click();
  await page.goto(`${baseUrl}/display/outside`);
  await page.locator('.display-root--outside').waitFor();
  assert.equal(await page.locator('.display-root--outside.display-root--light').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? null), null);
  await page.goto(`${baseUrl}/display/inside`);
  await page.locator('.display-root--inside.display-root--dark').waitFor();
  await page.goto(`${baseUrl}/display/inside?thema=licht`);
  await page.locator('.display-root--inside.display-root--light').waitFor();
  // The choice made on the display itself is remembered by that display's browser.
  await page.goto(`${baseUrl}/display/inside`);
  await page.getByRole('group', { name: 'Weergave van dit scherm' }).getByRole('button', { name: 'Licht' }).click();
  await page.locator('.display-root--inside.display-root--light').waitFor();
  await page.reload();
  await page.locator('.display-root--inside.display-root--light').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? null), null);
  await page.goto(`${baseUrl}/queue`);
  await page.getByRole('button', { name: 'Loper zoeken', exact: true }).waitFor();
  assert.equal((await theme(page)).theme, 'dark');
  console.log('PASS displays ignore the operator theme and support an explicit ?thema override');
  await context.close();
} finally {
  await browser.close();
}
