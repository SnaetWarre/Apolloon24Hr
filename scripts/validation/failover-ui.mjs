// Two laptops: APOLLOON_TEST_URL (seeded, will disappear) and APOLLOON_OTHER_URL.
// APOLLOON_TEST_PID is the process to stop. Started by scripts/validation/run.mjs.
import assert from 'node:assert/strict';

const firstUrl = process.env.APOLLOON_TEST_URL;
const otherUrl = process.env.APOLLOON_OTHER_URL;
const firstPid = Number(process.env.APOLLOON_TEST_PID);
assert.ok(firstUrl && otherUrl && firstPid, 'Start this check through scripts/validation/run.mjs');

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('Expected state was not reached');
}

const join = await fetch(`${otherUrl}/trpc/cluster.join`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ primaryUrl: firstUrl }),
});
assert.equal(join.ok, true, await join.text());
await waitUntil(async () =>
  (await (await fetch(`${firstUrl}/api/cluster/status`)).json()).memberUrls.includes(otherUrl)
);

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
try {
  const tv = await browser.newPage();
  const electron = await browser.newPage({ userAgent: 'Mozilla/5.0 Chrome/140.0 Electron/44.3.0 Safari/537.36' });
  await electron.goto(`${firstUrl}/display/outside`);
  await tv.goto(`${firstUrl}/display/outside`);
  await tv.waitForFunction(
    (url) => JSON.parse(localStorage.getItem('apolloon.cluster-members') || '[]').includes(url),
    otherUrl
  );

  process.kill(firstPid, 'SIGKILL');
  // The display waits a few seconds for its own laptop to return, then reopens elsewhere.
  await tv.waitForURL(`${otherUrl}/display/outside`, { timeout: 25_000 });
  await tv.locator('#root > *').first().waitFor();
  console.log('PASS a browser display reopens on another laptop when its laptop disappears');

  assert.equal(new URL(electron.url()).origin, firstUrl, 'the Electron app stays on its own laptop');
  console.log('PASS the Electron app never switches away from its own laptop');
} finally {
  await browser.close();
}
