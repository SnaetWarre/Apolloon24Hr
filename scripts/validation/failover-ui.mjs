// Three laptops: APOLLOON_TEST_URL (seeded, will disappear) and the comma-separated APOLLOON_OTHER_URLS.
// APOLLOON_TEST_PID is the process to stop. Started by scripts/validation/run.mjs.
import assert from 'node:assert/strict';

const firstUrl = process.env.APOLLOON_TEST_URL;
const otherUrls = (process.env.APOLLOON_OTHER_URLS || '').split(',').filter(Boolean);
const firstPid = Number(process.env.APOLLOON_TEST_PID);
assert.ok(firstUrl && otherUrls.length === 2 && firstPid, 'Start this check through scripts/validation/run.mjs');
const [secondUrl, thirdUrl] = otherUrls;

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('Expected state was not reached');
}

async function status(url) {
  return (await fetch(`${url}/api/cluster/status`)).json();
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
try {
  const electronAgent = 'Mozilla/5.0 Chrome/140.0 Electron/44.3.0 Safari/537.36';

  // Each new laptop lists the first one by itself; linking is one click and a confirmation.
  for (const url of otherUrls) {
    const setup = await browser.newPage({ userAgent: electronAgent });
    await setup.goto(`${url}/admin`);
    await setup.locator('.management-navigation').getByText('Systeem & herstel').click();
    const found = setup.locator('.cluster-peer-row', { hasText: new URL(firstUrl).host });
    await found.getByRole('button', { name: 'Koppelen' }).click({ timeout: 15_000 });
    await setup.getByRole('dialog').getByRole('button', { name: 'Koppelen' }).click();
    await setup.getByText(/^Gekoppeld\./).waitFor({ timeout: 20_000 });
    await setup.close();
  }
  await waitUntil(async () => (await status(firstUrl)).state === 'healthy');
  console.log('PASS a new laptop finds the others by itself and links in one click');

  const tv = await browser.newPage();
  const electron = await browser.newPage({ userAgent: electronAgent });
  const desk = await browser.newPage({ userAgent: electronAgent, viewport: { width: 1280, height: 800 } });
  await electron.goto(`${firstUrl}/display/outside`);
  await tv.goto(`${firstUrl}/display/outside`);
  await desk.goto(`${secondUrl}/admin`);
  await desk.locator('.management-navigation').getByText('Systeem & herstel').click();
  const groupState = desk.locator('.cluster-state');
  await groupState.getByText('Alles veilig').waitFor();
  await tv.waitForFunction(
    (urls) => urls.every((url) => JSON.parse(localStorage.getItem('apolloon.cluster-members') || '[]').includes(url)),
    otherUrls
  );

  process.kill(firstPid, 'SIGKILL');
  // The two laptops left are a majority: they choose a new main laptop by themselves and say one is missing.
  await groupState.getByText('Eén laptop onbereikbaar').waitFor({ timeout: 15_000 });
  console.log('PASS the other laptops carry on by themselves and say that one laptop is missing');

  const write = await fetch(`${thirdUrl}/trpc/runners.create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'After the failure', runnerNumber: 'FAIL-1' }),
  });
  assert.equal(write.ok, true, await write.text());
  console.log('PASS changes are still saved after a laptop disappears');

  // The display waits a few seconds for its own laptop to return, then reopens elsewhere.
  await tv.waitForURL((url) => otherUrls.includes(url.origin) && url.pathname === '/display/outside', {
    timeout: 25_000,
  });
  await tv.locator('#root > *').first().waitFor();
  console.log('PASS a browser display reopens on another laptop when its laptop disappears');

  assert.equal(new URL(electron.url()).origin, firstUrl, 'the Electron app stays on its own laptop');
  console.log('PASS the Electron app never switches away from its own laptop');
} finally {
  await browser.close();
}
