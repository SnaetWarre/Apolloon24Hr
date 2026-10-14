// Every button or fold-out that opens text fields puts the cursor in the first one, so the operator
// can click once and type. A new button that opens text fields belongs in this list.
// Runs against a disposable, ready-seeded server with linking on (see run.mjs).
import assert from 'node:assert/strict';
import { createTRPCClient, httpBatchLink } from '@trpc/client';

const baseUrl = process.env.APOLLOON_TEST_URL;
assert.ok(baseUrl && ['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const rpc = createTRPCClient({ links: [httpBatchLink({ url: `${baseUrl}/trpc` })] });
const snapshot = async () => (await fetch(`${baseUrl}/api/state`)).json();
const expectation = async () => {
  const { race } = await snapshot();
  return { activeRunnerId: race.activeRunnerId, activeStartedAt: race.activeStartedAt };
};

/** Fails unless the field has the cursor; then types without clicking and checks the text landed there. */
async function typesInto(where, field, text) {
  // A fold-out moves the cursor on its toggle event, one task after the click.
  await field.evaluate(
    (element) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 2_000;
        const poll = () =>
          element === document.activeElement
            ? resolve()
            : Date.now() > deadline
              ? reject(new Error(`cursor is on ${document.activeElement?.outerHTML.slice(0, 120)}`))
              : setTimeout(poll, 20);
        poll();
      })
  );
  if (text) {
    await page.keyboard.type(text);
    assert.equal(await field.inputValue(), text, where);
  }
  console.log(`PASS ${where}`);
}

try {
  // Setup: two laps, so the lap fixes have something to open.
  const { runners } = await snapshot();
  for (const runner of runners.slice(1, 4)) await rpc.runners.setStatus.mutate({ id: runner.id, status: 'waiting' });
  await rpc.race.startNext.mutate(await expectation());
  await rpc.race.handoff.mutate(await expectation());
  await rpc.race.handoff.mutate(await expectation());

  await page.goto(`${baseUrl}/queue`);
  await page.getByRole('button', { name: 'Loper zoeken', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Loper zoeken', exact: true });
  await typesInto(
    'Wachtrij › Loper zoeken',
    search.getByRole('textbox', { name: 'Zoek op nummer, naam of label' }),
    'ab'
  );
  await page.keyboard.press('Escape');
  await search.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'Nieuwe loper', exact: true }).click();
  let newRunner = page.getByRole('dialog', { name: 'Nieuwe loper', exact: true });
  await typesInto('Wachtrij › Nieuwe loper', newRunner.getByRole('textbox', { name: 'Lopersnummer' }), '7');
  await newRunner.getByText('Contact en beschikbaarheid').click();
  await typesInto(
    'Nieuwe loper › Contact en beschikbaarheid',
    newRunner.getByRole('textbox', { name: 'Telefoon' }),
    '0470'
  );
  await newRunner.getByText('Extra gegevens').click();
  await typesInto(
    'Nieuwe loper › Extra gegevens',
    newRunner.getByRole('spinbutton', { name: 'Historisch gemiddelde' }).first(),
    '5'
  );

  await page.goto(`${baseUrl}/admin?section=runners`);
  await page.getByRole('button', { name: 'Nieuwe loper', exact: true }).click();
  newRunner = page.getByRole('dialog', { name: 'Nieuwe loper', exact: true });
  await typesInto('Beheer › Lopers › Nieuwe loper', newRunner.getByRole('textbox', { name: 'Lopersnummer' }), '8');

  await page.goto(`${baseUrl}/admin?section=laps`);
  for (const [button, dialogName] of [
    ['Andere loper', 'Ronde naar andere loper'],
    ['Splitsen', 'Ronde splitsen'],
  ]) {
    await page.locator('.laps-table tbody tr').first().getByRole('button', { name: button, exact: true }).click();
    const fix = page.getByRole('dialog', { name: dialogName, exact: true });
    await typesInto(`Beheer › Rondes › ${button}`, fix.getByRole('textbox', { name: 'Loper zoeken' }), 'ab');
    await page.keyboard.press('Escape');
    await fix.waitFor({ state: 'detached' });
  }

  // With the cursor already there, a runner number and Enter move the lap, as Enter does in Loper zoeken.
  const lapsNow = async () => (await (await fetch(`${baseUrl}/api/history?scope=full`)).json()).laps;
  const newest = (await lapsNow()).sort((a, b) => b.finishedAt - a.finishedAt)[0];
  const searchText = (runner) =>
    `${runner.runnerNumber ?? ''} ${runner.name} ${runner.labels.map((label) => label.name).join(' ')}`.toLowerCase();
  const others = (await snapshot()).runners.filter((runner) => runner.id !== newest.runnerId);
  const target = others.find(
    (runner) =>
      runner.runnerNumber && others.filter((other) => searchText(other).includes(runner.runnerNumber)).length === 1
  );
  await page.locator('.laps-table tbody tr').first().getByRole('button', { name: 'Andere loper', exact: true }).click();
  const move = page.getByRole('dialog', { name: 'Ronde naar andere loper', exact: true });
  await typesInto(
    'Beheer › Rondes › Andere loper, nummer',
    move.getByRole('textbox', { name: 'Loper zoeken' }),
    target.runnerNumber
  );
  assert.equal(await move.getByRole('radio').count(), 1);
  await page.keyboard.press('Enter');
  await move.waitFor({ state: 'detached', timeout: 2_000 });
  await page.getByText(/staat nu op/).waitFor();
  assert.equal((await lapsNow()).find((lap) => lap.id === newest.id).runnerId, target.id);
  console.log('PASS Beheer › Rondes › Andere loper: a runner number and Enter move the lap');

  await page.goto(`${baseUrl}/admin?section=system`);
  await page.getByText('Laptop niet in de lijst? Vul het adres in').click();
  await typesInto(
    'Systeem & herstel › Laptop niet in de lijst',
    page.getByRole('textbox', { name: 'Adres van een andere laptop' }),
    'http://10.0.0.2'
  );
} finally {
  await browser.close();
}
