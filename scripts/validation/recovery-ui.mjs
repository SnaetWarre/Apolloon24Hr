import assert from 'node:assert/strict';

const baseUrl = process.env.APOLLOON_TEST_URL;
assert.ok(baseUrl && ['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage();
try {
  let blocked = true;
  let requests = 0;
  await page.route('**/assets/DisplayViews-*.js', async (route) => {
    requests += 1;
    if (blocked) await route.abort();
    else await route.continue();
  });
  await page.goto(`${baseUrl}/display/outside`);
  const recovery = page.getByRole('alert').filter({ hasText: 'Scherm wordt opnieuw geladen' });
  await recovery.waitFor();
  const failedRequests = requests;
  blocked = false;
  await page.getByText('Nu op de piste', { exact: true }).waitFor({ timeout: 25_000 });
  assert.ok(requests > failedRequests, 'the unattended retry downloads the chunk again');
  assert.equal(await recovery.count(), 0);
  console.log('PASS a public display recovers automatically after a failed chunk download when the network returns');
} finally {
  await browser.close();
}
