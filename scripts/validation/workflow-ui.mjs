// Run against a disposable, ready-seeded server, never an event database.
// APOLLOON_TEST_URL=http://127.0.0.1:3187 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
// CHROMIUM_EXECUTABLE=/path/to/chrome node scripts/validation/workflow-ui.mjs
import assert from 'node:assert/strict';
import { createTRPCClient, httpBatchLink } from '@trpc/client';

const baseUrl = process.env.APOLLOON_TEST_URL;
assert.ok(baseUrl && ['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname), 'Use an explicitly configured disposable localhost server');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const rpc = createTRPCClient({ links: [httpBatchLink({ url: `${baseUrl}/trpc` })] });
const snapshot = async () => (await fetch(`${baseUrl}/api/state`)).json();
const expectation = async () => {
  const { race } = await snapshot();
  return { activeRunnerId: race.activeRunnerId, activeStartedAt: race.activeStartedAt };
};
async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Expected state was not reached');
}
try {
  const initial = await snapshot();
  assert.equal(initial.race.raceStartedAt, null, 'Requires a fresh ready seed');
  const [firstRunner, secondRunner] = initial.runners;
  for (const runner of initial.runners.filter((runner) => runner.status === 'waiting')) {
    await rpc.runners.setStatus.mutate({ id: runner.id, status: 'warming_up' });
  }
  await page.goto(`${baseUrl}/timing`);
  await page.getByRole('button', { name: 'Geen loper klaar' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Geen loper klaar' }).isDisabled(), true);
  await page.keyboard.press('Space');
  assert.equal((await snapshot()).race.activeRunnerId, null);
  await rpc.runners.setStatus.mutate({ id: firstRunner.id, status: 'waiting' });
  await page.getByRole('button', { name: 'Start volgende loper' }).waitFor();
  await page.keyboard.press('Control+Enter');
  assert.equal((await snapshot()).race.activeRunnerId, null);
  await page.keyboard.press('Space');
  await waitUntil(async () => (await snapshot()).race.activeRunnerId === firstRunner.id);
  await page.getByRole('button', { name: 'Ronde opslaan' }).waitFor();
  await page.keyboard.press('Space');
  await page.getByText('Ronde opgeslagen. Niemand actief; de wachtrij is leeg.').waitFor();
  assert.equal((await snapshot()).race.activeRunnerId, null);
  console.log('PASS empty queue, modified shortcuts, final runner handoff feedback');

  await rpc.runners.setStatus.mutate({ id: firstRunner.id, status: 'waiting' });
  await rpc.race.startNext.mutate(await expectation());
  await rpc.runners.setStatus.mutate({ id: secondRunner.id, status: 'waiting' });
  await page.getByRole('button', { name: 'Race beeindigen', exact: true }).click();
  await page.getByRole('button', { name: 'Verder', exact: true }).click();
  await page.getByRole('button', { name: 'Race definitief beeindigen' }).click();
  await page.getByRole('button', { name: 'Race hervatten' }).waitFor();
  await page.locator('h1').click();
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  assert.ok((await snapshot()).race.raceFinishedAt);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Race hervatten' }).click();
  assert.equal((await snapshot()).race.activeRunnerId, null);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Race hervatten' }).click();
  await waitUntil(async () => (await snapshot()).race.activeRunnerId === secondRunner.id);
  console.log('PASS finished race ignores timing shortcuts and requires confirmed resumption');

  await rpc.runners.setStatus.mutate({ id: firstRunner.id, status: 'warming_up' });
  await page.goto(`${baseUrl}/queue`);
  await page.locator('button.queue-identity').filter({ hasText: firstRunner.name }).click();
  const nameInput = page.getByRole('textbox', { name: 'Naam', exact: true });
  await nameInput.fill('Unsaved local draft');
  await rpc.runners.update.mutate({ id: firstRunner.id, fields: { notes: 'Remote operator edit' } });
  await page.getByText('Dit profiel is intussen elders gewijzigd.', { exact: false }).waitFor();
  assert.equal(await nameInput.inputValue(), 'Unsaved local draft');
  assert.equal(await page.getByRole('button', { name: 'Opslaan', exact: true }).isDisabled(), true);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Nieuwste profiel laden' }).click();
  assert.equal(await nameInput.inputValue(), firstRunner.name);
  assert.equal(await page.getByRole('textbox', { name: 'Notities' }).inputValue(), 'Remote operator edit');
  await rpc.runners.update.mutate({ id: firstRunner.id, fields: { notes: 'Clean draft auto refresh' } });
  await waitUntil(async () => await page.getByRole('textbox', { name: 'Notities' }).inputValue() === 'Clean draft auto refresh');
  assert.equal(await page.getByRole('button', { name: 'Opslaan', exact: true }).isDisabled(), false);
  console.log('PASS remote profile edits preserve dirty drafts and refresh clean drafts');

  // Move the returning runner's previous lap outside the old 250-lap window.
  const thirdRunner = initial.runners[2];
  for (let lapIndex = 0; lapIndex < 251; lapIndex++) {
    const nextRunnerId = lapIndex % 2 === 0 ? thirdRunner.id : secondRunner.id;
    await rpc.runners.setStatus.mutate({ id: nextRunnerId, status: 'waiting' });
    await rpc.race.handoff.mutate(await expectation());
  }
  await rpc.runners.setStatus.mutate({ id: firstRunner.id, status: 'waiting' });
  await rpc.race.handoff.mutate(await expectation());
  await page.goto(`${baseUrl}/timing`);
  const previousLapPanel = page.locator('.stat-panel').filter({ hasText: 'Vorige ronde huidige loper' });
  await waitUntil(async () => /[0-9]/.test(await previousLapPanel.locator('strong').innerText()));
  const recentHistory = await (await fetch(`${baseUrl}/api/history?scope=recent&limit=250`)).json();
  assert.equal(recentHistory.laps.some((lap) => lap.runnerId === firstRunner.id), false);
  console.log('PASS returning runner previous lap remains visible beyond 250 intervening laps');

  await page.route('**/api/history?scope=recent*', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto(`${baseUrl}/timing`);
  await page.getByText('Rondes konden niet worden bijgewerkt.', { exact: false }).waitFor();
  assert.equal(await page.getByText('Nog geen rondes geregistreerd', { exact: true }).count(), 0);
  console.log('PASS history failure is distinct from an empty race');
} finally {
  await browser.close();
}
