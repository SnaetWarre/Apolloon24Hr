// Run against a disposable, ready-seeded server, never an event database.
// APOLLOON_TEST_URL=http://127.0.0.1:3187 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
// CHROMIUM_EXECUTABLE=/path/to/chrome node scripts/validation/workflow-ui.mjs
import assert from 'node:assert/strict';
import { createTRPCClient, httpBatchLink } from '@trpc/client';

const baseUrl = process.env.APOLLOON_TEST_URL;
assert.ok(
  baseUrl && ['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname),
  'Use an explicitly configured disposable localhost server'
);
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
  const checkinRunner = initial.runners[3];
  await rpc.runners.update.mutate({ id: checkinRunner.id, fields: { runnerNumber: '10' } });
  await rpc.runners.setStatus.mutate({ id: checkinRunner.id, status: 'registered' });
  await rpc.runners.setStatus.mutate({ id: firstRunner.id, status: 'registered' });
  await page.goto(`${baseUrl}/queue`);
  const boardFilter = page.getByRole('searchbox', { name: 'Filter dit bord' });
  await boardFilter.fill('No matching runner');
  await page.getByRole('button', { name: 'Loper zoeken', exact: true }).click();
  const checkinSearch = page.getByRole('textbox', { name: 'Zoek op nummer, naam of label', exact: true });
  await checkinSearch.fill('10');
  assert.equal(await page.locator('.runner-search-row').count(), 1);
  await page.getByRole('checkbox', { name: 'Meerdere lopers aanmelden' }).check();
  await checkinSearch.press('Enter');
  await page.getByText(`${checkinRunner.name} staat bij opwarming.`, { exact: true }).waitFor();
  assert.equal(await checkinSearch.inputValue(), '');
  assert.equal(await checkinSearch.evaluate((input) => input === document.activeElement), true);
  assert.equal(await boardFilter.inputValue(), '');
  await checkinSearch.fill(firstRunner.runnerNumber);
  await checkinSearch.press('Enter');
  await page.getByText(`${firstRunner.name} staat bij opwarming.`, { exact: true }).waitFor();
  await checkinSearch.press('Escape');
  await page.locator('button.queue-identity').filter({ hasText: checkinRunner.name }).waitFor();
  assert.equal((await snapshot()).runners.find((runner) => runner.id === firstRunner.id).status, 'warming_up');
  await boardFilter.fill('No matching runner');
  await page.getByRole('button', { name: 'Filter wissen', exact: true }).click();
  assert.equal(await boardFilter.inputValue(), '');
  console.log('PASS exact bib lookup, repeated check-in, focus restoration, and board filter clearing');
  for (const runner of initial.runners.filter((runner) => runner.status === 'waiting')) {
    await rpc.runners.setStatus.mutate({ id: runner.id, status: 'warming_up' });
  }
  await page.goto(`${baseUrl}/timing`);
  await page.getByRole('button', { name: 'Geen loper klaar' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Geen loper klaar' }).isDisabled(), true);
  await page.keyboard.press('Space');
  assert.equal((await snapshot()).race.activeRunnerId, null);
  await rpc.runners.setStatus.mutate({ id: firstRunner.id, status: 'waiting' });
  await page.getByRole('button', { name: /^Start / }).waitFor();
  await page.keyboard.press('Control+Enter');
  assert.equal((await snapshot()).race.activeRunnerId, null);
  await page.keyboard.press('Space');
  await waitUntil(async () => (await snapshot()).race.activeRunnerId === firstRunner.id);
  await page.getByRole('button', { name: /^Klok / }).waitFor();
  // The React Compiler once cached the clock's time read, and the lap clock stood still.
  const lapClock = page.getByRole('timer', { name: 'Lopende rondetijd' });
  const clockBefore = await lapClock.innerText();
  await page.waitForTimeout(400);
  assert.notEqual(await lapClock.innerText(), clockBefore, 'The lap clock keeps running');
  await page.keyboard.press('Space');
  await page.getByText('Ronde opgeslagen. Niemand actief; de wachtrij is leeg.').waitFor();
  assert.equal((await snapshot()).race.activeRunnerId, null);
  console.log('PASS empty queue, modified shortcuts, running lap clock, final runner handoff feedback');

  await rpc.runners.setStatus.mutate({ id: firstRunner.id, status: 'waiting' });
  await rpc.race.startNext.mutate(await expectation());
  await rpc.runners.setStatus.mutate({ id: secondRunner.id, status: 'waiting' });
  const finishDialog = page.getByRole('dialog', { name: 'Race afsluiten', exact: true });
  await page.getByRole('button', { name: 'Race beëindigen', exact: true }).click();
  const stoppedClock = await lapClock.textContent();
  await page.waitForTimeout(300);
  assert.equal(await lapClock.textContent(), stoppedClock, 'The first finish click stops the clock');
  await finishDialog.getByRole('button', { name: 'Annuleer', exact: true }).click();
  await page.waitForTimeout(300);
  assert.notEqual(await lapClock.textContent(), stoppedClock, 'Cancelling lets the clock run on');
  assert.equal((await snapshot()).race.raceFinishedAt, null);
  const beforeFinishClick = Date.now();
  await page.getByRole('button', { name: 'Race beëindigen', exact: true }).click();
  await page.waitForTimeout(1_000);
  await page.getByRole('button', { name: 'Verder', exact: true }).click();
  await page.getByRole('button', { name: 'Race definitief beeindigen' }).click();
  await page.getByRole('button', { name: 'Race hervatten' }).waitFor();
  assert.ok((await snapshot()).race.raceFinishedAt < beforeFinishClick + 900, 'The race ends at the first click');
  console.log('PASS the first finish click stops the clock and cancelling resumes it');
  await page.locator('h1').click();
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  assert.ok((await snapshot()).race.raceFinishedAt);
  const resumePrompt = page.getByRole('dialog', { name: 'Race hervatten?', exact: true });
  await page.getByRole('button', { name: 'Race hervatten' }).click();
  await resumePrompt.getByRole('button', { name: 'Annuleer', exact: true }).click();
  await resumePrompt.waitFor({ state: 'detached' });
  assert.equal((await snapshot()).race.activeRunnerId, null);
  await page.getByRole('button', { name: 'Race hervatten' }).click();
  await resumePrompt.getByRole('button', { name: 'Race hervatten', exact: true }).click();
  await waitUntil(async () => (await snapshot()).race.activeRunnerId === secondRunner.id);
  console.log('PASS finished race ignores timing shortcuts and requires confirmed resumption');

  const raceBeforeUndoPrompt = (await snapshot()).race;
  const undoPrompt = page.getByRole('dialog', { name: 'Laatste wissel ongedaan maken?', exact: true });
  await page.getByRole('button', { name: 'Laatste wissel ongedaan maken', exact: true }).click();
  await page.keyboard.press('Space');
  await undoPrompt.waitFor({ state: 'detached' });
  const raceAfterUndoPrompt = (await snapshot()).race;
  assert.equal(raceAfterUndoPrompt.activeRunnerId, raceBeforeUndoPrompt.activeRunnerId);
  assert.equal(raceAfterUndoPrompt.activeStartedAt, raceBeforeUndoPrompt.activeStartedAt);
  console.log('PASS Space inside a timing confirmation cancels it without recording a handoff');

  await rpc.runners.setStatus.mutate({ id: firstRunner.id, status: 'warming_up' });
  await page.goto(`${baseUrl}/queue`);
  await page.locator('button.queue-identity').filter({ hasText: firstRunner.name }).click();
  const nameInput = page.getByRole('textbox', { name: 'Naam', exact: true });
  await nameInput.fill('Unsaved local draft');
  await rpc.runners.update.mutate({ id: firstRunner.id, fields: { notes: 'Remote operator edit' } });
  await page.getByText('Dit profiel is intussen elders gewijzigd.', { exact: false }).waitFor();
  assert.equal(await nameInput.inputValue(), 'Unsaved local draft');
  assert.equal(await page.getByRole('button', { name: 'Opslaan', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Nieuwste profiel laden' }).click();
  await page
    .getByRole('dialog', { name: 'Nieuwste profiel laden?', exact: true })
    .getByRole('button', { name: 'Nieuwste laden', exact: true })
    .click();
  assert.equal(await nameInput.inputValue(), firstRunner.name);
  assert.equal(await page.getByRole('textbox', { name: 'Notities' }).inputValue(), 'Remote operator edit');
  await rpc.runners.update.mutate({ id: firstRunner.id, fields: { notes: 'Clean draft auto refresh' } });
  await waitUntil(
    async () => (await page.getByRole('textbox', { name: 'Notities' }).inputValue()) === 'Clean draft auto refresh'
  );
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
  const previousLapPanel = page.locator('.stat-panel').filter({ hasText: 'Vorige ronde' });
  await waitUntil(async () => /[0-9]/.test(await previousLapPanel.locator('strong').innerText()));
  const recentHistory = await (await fetch(`${baseUrl}/api/history?scope=recent&limit=250`)).json();
  assert.equal(
    recentHistory.laps.some((lap) => lap.runnerId === firstRunner.id),
    false
  );
  console.log('PASS returning runner previous lap remains visible beyond 250 intervening laps');

  await page.route('**/api/history?scope=recent*', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto(`${baseUrl}/timing`);
  await page.getByText('Rondes konden niet worden bijgewerkt.', { exact: false }).waitFor();
  assert.equal(await page.getByText('Nog geen rondes geregistreerd', { exact: true }).count(), 0);
  console.log('PASS history failure is distinct from an empty race');

  // Another timing station can start a runner before the queue desk receives confirmation of their move.
  const queueRunner = await rpc.runners.create.mutate({ name: 'Concurrent queue runner', runnerNumber: '9073' });
  for (const runner of (await snapshot()).runners.filter((runner) => runner.status === 'waiting')) {
    await rpc.runners.setStatus.mutate({ id: runner.id, status: 'warming_up' });
  }
  await rpc.runners.setStatus.mutate({ id: queueRunner.id, status: 'warming_up' });
  await page.goto(`${baseUrl}/queue`);
  const queueRow = page.locator('.queue-runner').filter({
    has: page.locator('button.queue-identity').filter({ hasText: queueRunner.name }),
  });
  await queueRow.getByRole('button', { name: 'Naar wachtrij', exact: true }).waitFor();
  const moveRoute = '**/trpc/runners.setStatus*';
  await page.route(moveRoute, async (route) => {
    const response = await route.fetch();
    await rpc.race.handoff.mutate(await expectation());
    assert.equal((await snapshot()).race.activeRunnerId, queueRunner.id);
    await route.fulfill({ response });
  });
  try {
    const moved = page.waitForResponse(moveRoute);
    await queueRow.getByRole('button', { name: 'Naar wachtrij', exact: true }).click();
    await moved;
    await queueRow.waitFor({ state: 'detached' });
    assert.equal((await snapshot()).runners.find((runner) => runner.id === queueRunner.id).status, 'running');
  } finally {
    await page.unroute(moveRoute);
  }
  console.log('PASS a runner started elsewhere leaves the queue when their pending move is confirmed');

  // Settling an optimistic change must not hide a failed refresh of the server snapshot.
  const failedRefreshRunner = await rpc.runners.create.mutate({ name: 'Queue refresh runner', runnerNumber: '9074' });
  await rpc.runners.setStatus.mutate({ id: failedRefreshRunner.id, status: 'warming_up' });
  await page.goto(`${baseUrl}/queue`);
  const refreshRow = page.locator('.queue-runner').filter({
    has: page.locator('button.queue-identity').filter({ hasText: failedRefreshRunner.name }),
  });
  await refreshRow.getByRole('button', { name: 'Naar wachtrij', exact: true }).waitFor();
  await page.route('**/api/state', (route) => route.fulfill({ status: 503, body: 'Unavailable' }));
  try {
    await refreshRow.getByRole('button', { name: 'Naar wachtrij', exact: true }).click();
    const connectionError = page.getByRole('heading', { name: 'Geen verbinding met de lokale server', exact: true });
    await connectionError.waitFor();
    await page.waitForTimeout(300);
    assert.equal(await connectionError.isVisible(), true);
  } finally {
    await page.unroute('**/api/state');
  }
  await page.getByRole('button', { name: 'Opnieuw proberen', exact: true }).click();
  await refreshRow.getByRole('button', { name: 'Opwarmen', exact: true }).waitFor();
  console.log('PASS a failed queue refresh keeps the connection error visible and recovers on retry');
} finally {
  await browser.close();
}
