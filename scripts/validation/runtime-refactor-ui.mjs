// Capture matched refactor evidence against a disposable ready-seeded server.
// Reuse the same server data and evidence fixture for before/after captures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.APOLLOON_TEST_URL;
assert.ok(baseUrl && ['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname));
const revision = process.argv[2];
assert.ok(['before', 'after'].includes(revision));
// Screenshots belong on the PR as attachments, not in the repository.
const evidence = path.resolve(process.env.EVIDENCE_DIR || '.test-data/runtime-refactor-ui/evidence');
const fixturePath = path.resolve('.test-data/runtime-refactor-ui/visual-fixture.json');
await fs.mkdir(evidence, { recursive: true });
const endpoints = ['/api/state', '/api/cluster/status', '/api/history?scope=full'];
if (revision === 'before') {
  const fixture = {};
  for (const endpoint of endpoints) {
    const response = await fetch(`${baseUrl}${endpoint}`);
    assert.equal(response.ok, true, endpoint);
    fixture[endpoint] = await response.json();
  }
  await fs.writeFile(fixturePath, JSON.stringify(fixture));
}
const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, timezoneId: 'Europe/Brussels' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  for (const endpoint of endpoints) {
    await page.route(`${baseUrl}${endpoint}`, (route) => route.fulfill({ json: fixture[endpoint] }));
  }
  const capture = async (name) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400); // Allow chart animation to settle.
    await page.screenshot({ path: path.join(evidence, `${name}-${revision}.png`), animations: 'disabled' });
  };
  await page.goto(`${baseUrl}/queue`);
  const filter = page.getByRole('searchbox', { name: 'Filter dit bord' });
  await filter.fill('Kobe');
  await capture('queue-search');
  await page.getByRole('link', { name: 'Beheer', exact: true }).click();
  await page.getByRole('heading', { name: 'Wedstrijdgereedheid' }).waitFor();
  await capture('admin-preparation');
  for (const [name, label] of [['runners', 'Lopers'], ['labels', 'Ploegen & labels'], ['public', 'Publiek'], ['system', 'Systeem & herstel']]) {
    await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
    await capture(`admin-${name}`);
  }
  await page.getByRole('link', { name: 'Wachtrij', exact: true }).click();
  assert.equal(await filter.inputValue(), 'Kobe', 'Queue search survives navigation');
  await page.getByRole('button', { name: 'Filter wissen', exact: true }).click();
  assert.equal(await filter.inputValue(), '');
  await page.getByRole('link', { name: "Kobe's tactiek", exact: true }).click();
  await page.getByRole('button', { name: 'Analyse vorig jaar', exact: true }).waitFor();
  // The frozen ready fixture has no started race and no laps, so the live tab
  // shows its pre-race empty state. The bundled Quivr reference only renders
  // once the historical tab is opened.
  await page.getByText('Start eerst de wedstrijd', { exact: true }).waitFor();
  await capture('tactics-live');
  await page.getByRole('button', { name: 'Analyse vorig jaar', exact: true }).click();
  await page.getByText('Quivr 2025', { exact: true }).first().waitFor();
  for (const [name, label] of [['overview', 'Alle teams'], ['tempo', 'Tempo A vs. B'], ['race', 'Raceverloop'], ['diagnostics', 'Diagnostiek'], ['drafting', 'Volgeffect']]) {
    await page.getByRole('button', { name: new RegExp(`^${label.replaceAll('.', '\\.')}`) }).click();
    await capture(`tactics-${name}`);
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${revision}: matched operator screens, all tactics sections, queue search across navigation, no browser errors`);
} finally {
  await browser.close();
}
