// The race-day walkthrough on three laptops, timed. Every step checks what an operator would see and has
// a budget: a step that gets slower than its budget fails the check, so a slowdown shows up in CI.
// Started by scripts/validation/run.mjs, which passes the laptops in APOLLOON_LAPTOPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from './laptop.mjs';

const laptops = JSON.parse(process.env.APOLLOON_LAPTOPS || '[]');
const discoveryPort = Number(process.env.APOLLOON_DISCOVERY_PORT);
assert.ok(laptops.length === 3 && discoveryPort, 'Start this check through scripts/validation/run.mjs');
const [firstUrl] = laptops.map((laptop) => laptop.url);
// Waits stay well above the budgets: a slow step should report its time, not just a timeout.
const PATIENCE_MS = 30_000;
const electronAgent = 'Mozilla/5.0 Chrome/140.0 Electron/44.3.0 Safari/537.36';

const timings = [];
function record(description, ms, budgetMs) {
  const rounded = Math.round(ms);
  timings.push({ description, ms: rounded, budgetMs });
  assert.ok(rounded <= budgetMs, `${description}: ${rounded} ms, budget ${budgetMs} ms`);
  console.log(`PASS ${description} (${rounded} ms, budget ${budgetMs} ms)`);
}

async function rpc(url, procedure, input) {
  const response = await fetch(`${url}/trpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.text();
  assert.equal(response.ok, true, `${procedure} on ${url}: ${body}`);
  return JSON.parse(body).result.data;
}
const status = async (url) => (await fetch(`${url}/api/cluster/status`)).json();
const snapshot = async (url) => (await fetch(`${url}/api/state`)).json();
const laps = async (url) => (await (await fetch(`${url}/api/history?scope=full`)).json()).laps;

async function waitUntil(predicate, timeoutMs = PATIENCE_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Expected state was not reached');
}

/** Wall-clock time at which `selector` first shows (or, with `absent`, stops showing) `text` on `page`. */
function shownAt(page, selector, text, { absent = false } = {}) {
  const seen = page
    .waitForFunction(
      ([selector, text, absent]) => {
        const shown = [...document.querySelectorAll(selector)].some((node) => node.textContent.includes(text));
        return shown !== absent && performance.timeOrigin + performance.now();
      },
      [selector, text, absent],
      { polling: 'raf', timeout: PATIENCE_MS }
    )
    .then((handle) => handle.jsonValue());
  // Observers start before their action; when an earlier step fails, the real error is reported, not this one.
  seen.catch(() => undefined);
  return seen;
}

/** Presses Space on Timing; returns when the key arrived and how long until the laptops confirmed it. */
async function press(timing) {
  const saved = timing.waitForResponse((response) => /\/trpc\/race\.(handoff|startNext)/.test(response.url()), {
    timeout: PATIENCE_MS,
  });
  await timing.keyboard.press('Space');
  assert.equal((await saved).ok(), true, 'the timing press is saved');
  return timing.evaluate(async () => {
    const key = window.__lastSpace;
    // Chromium adds the request's timing entry a moment after Playwright reports the response.
    for (let attempt = 0; attempt < 100; attempt++) {
      const request = performance
        .getEntriesByType('resource')
        .findLast((entry) => /\/trpc\/race\.(handoff|startNext)/.test(entry.name) && entry.startTime >= key.eventTime);
      if (request) return { ...key, savedMs: request.responseEnd - key.eventTime };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('The timing press request has no timing entry');
  });
}

/** Wall-clock time of the next click on `page`, taken from the click event itself. */
async function clickAt(page, locator) {
  await page.evaluate(() => {
    window.__lastClick = null;
    window.addEventListener('click', (event) => (window.__lastClick = performance.timeOrigin + event.timeStamp), {
      capture: true,
      once: true,
    });
  });
  await locator.click();
  return page.evaluate(() => window.__lastClick);
}

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
let restarted = null;
try {
  // A short queue, so every runner the walkthrough moves shows up in Timing's next five.
  const seeded = await snapshot(firstUrl);
  const [firstWaiting, secondWaiting, ...restWaiting] = seeded.runners.filter((runner) => runner.status === 'waiting');
  for (const runner of restWaiting) await rpc(firstUrl, 'runners.setStatus', { id: runner.id, status: 'warming_up' });

  let startedAt = performance.now();
  for (const { url } of laptops.slice(1)) await rpc(url, 'cluster.join', { url: firstUrl });
  await waitUntil(async () => {
    const states = await Promise.all(laptops.map(async ({ url }) => (await status(url)).state));
    return states.every((state) => state === 'healthy');
  });
  record('two laptops link to the first and all three are healthy', performance.now() - startedAt, 5_000);

  // The leader gets killed later; Timing and the desk run on the two others, the TV watches the leader.
  const leaderUrl = (await status(firstUrl)).leader.url;
  const leader = laptops.find((laptop) => laptop.url === leaderUrl);
  const [timingUrl, deskUrl] = laptops.filter((laptop) => laptop !== leader).map((laptop) => laptop.url);

  const timing = await browser.newPage({ userAgent: electronAgent, viewport: { width: 1366, height: 768 } });
  const desk = await browser.newPage({ userAgent: electronAgent, viewport: { width: 1366, height: 768 } });
  const admin = await browser.newPage({ userAgent: electronAgent, viewport: { width: 1280, height: 800 } });
  const tv = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  startedAt = performance.now();
  await timing.goto(`${timingUrl}/timing`);
  await timing.getByRole('button', { name: /^Start / }).waitFor({ timeout: PATIENCE_MS });
  record('Timing opens ready to start', performance.now() - startedAt, 2_000);
  await timing.evaluate(() => {
    // Live updates fetch on every change; keep every request's timing, not just the first 250.
    performance.setResourceTimingBufferSize(100_000);
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.code === 'Space')
          window.__lastSpace = { at: performance.timeOrigin + event.timeStamp, eventTime: event.timeStamp };
      },
      true
    );
  });

  startedAt = performance.now();
  await tv.goto(`${leaderUrl}/display/inside`);
  await tv.locator('.inside-now__next').getByText(firstWaiting.name).waitFor({ timeout: PATIENCE_MS });
  record('Binnenscherm opens with the next runner', performance.now() - startedAt, 2_000);

  startedAt = performance.now();
  await desk.goto(`${deskUrl}/queue`);
  await desk
    .getByRole('region', { name: 'Opwarming' })
    .locator('.queue-runner')
    .first()
    .waitFor({ timeout: PATIENCE_MS });
  record('Wachtrij opens with the warm-up lane filled', performance.now() - startedAt, 2_000);

  // 1. The first press starts the race; the TV on another laptop follows.
  // Observers start before the action, so a fast update is not reported late.
  let firstOnTv = shownAt(tv, '.inside-now__runner', firstWaiting.name);
  const firstPress = await press(timing);
  record('Timing press is confirmed by the laptops', firstPress.savedMs, 300);
  await timing.locator('.timing-now').getByText(firstWaiting.name).waitFor();
  firstOnTv = await firstOnTv;
  record('Timing press reaches the Binnenscherm on another laptop', firstOnTv - firstPress.at, 500);

  // 2. The desk moves a runner into the queue and back out; Timing on another laptop follows both.
  const readyLane = desk.getByRole('region', { name: 'Klaar om te lopen' });
  const warmupLane = desk.getByRole('region', { name: 'Opwarming' });
  const deskRow = (lane, name) =>
    lane.locator('.queue-runner').filter({ has: desk.locator('button.queue-identity', { hasText: name }) });
  const moved = restWaiting[0];
  const movedOnDesk = shownAt(desk, '[aria-label="Klaar om te lopen"] .queue-identity', moved.name);
  const movedOnTiming = shownAt(timing, '.timing-upcoming li', moved.name);
  let clickedAt = await clickAt(desk, deskRow(warmupLane, moved.name).getByRole('button', { name: 'Naar wachtrij' }));
  record('Wachtrij shows a queue move at once', (await movedOnDesk) - clickedAt, 150);
  record('a queue move reaches Timing on another laptop', (await movedOnTiming) - clickedAt, 500);
  const leftTiming = shownAt(timing, '.timing-upcoming li', moved.name, { absent: true });
  clickedAt = await clickAt(desk, deskRow(readyLane, moved.name).getByRole('button', { name: 'Opwarmen' }));
  record('taking a runner out of the queue reaches Timing', (await leftTiming) - clickedAt, 500);

  // 3. A new runner with a speedteam and a second label, entered on the desk.
  const labels = (await snapshot(deskUrl)).labels;
  const speedteam = labels.find((label) => label.kind === 'speedteam');
  const otherLabel = labels.find((label) => label.kind !== 'speedteam' && label.kind !== 'temporary_team');
  assert.ok(speedteam && otherLabel, 'the ready seed has labels of two kinds');
  const newcomer = { name: 'Race Dag Nieuwkomer', number: '777' };
  await desk.getByRole('button', { name: 'Nieuwe loper', exact: true }).click();
  const addDialog = desk.getByRole('dialog', { name: 'Nieuwe loper' });
  await addDialog.getByRole('textbox', { name: 'Lopersnummer' }).fill(newcomer.number);
  await addDialog.getByRole('textbox', { name: 'Naam' }).fill(newcomer.name);
  for (const label of [speedteam, otherLabel]) {
    await addDialog.locator('.check-pill', { hasText: label.name }).click();
    assert.equal(await addDialog.getByRole('checkbox', { name: label.name }).isChecked(), true);
  }
  const newcomerOnDesk = shownAt(desk, '[aria-label="Opwarming"] .queue-identity', newcomer.name);
  clickedAt = await clickAt(desk, addDialog.getByRole('button', { name: 'Toevoegen aan opwarmen' }));
  record('a new runner with labels is on the warm-up lane', (await newcomerOnDesk) - clickedAt, 500);
  const newRow = deskRow(warmupLane, newcomer.name);
  assert.deepEqual(
    (await newRow.locator('.label-pill').allInnerTexts()).map((text) => text.trim()).sort(),
    [speedteam.name, otherLabel.name].sort()
  );
  let newcomerId = null;
  await waitUntil(async () => {
    const copies = await Promise.all(
      laptops.map(async ({ url }) => (await snapshot(url)).runners.find((runner) => runner.name === newcomer.name))
    );
    newcomerId = copies[0]?.id ?? null;
    return copies.every(
      (copy) =>
        copy?.status === 'warming_up' &&
        copy.runnerNumber === newcomer.number &&
        [speedteam.id, otherLabel.id].every((id) => copy.labels.some((label) => label.id === id))
    );
  });
  record('the new runner and both labels are on all three laptops', Date.now() - clickedAt, 750);
  const newcomerQueued = shownAt(timing, '.timing-upcoming li', newcomer.name);
  clickedAt = await clickAt(desk, newRow.getByRole('button', { name: 'Naar wachtrij' }));
  record('the new runner reaches the queue on Timing', (await newcomerQueued) - clickedAt, 500);

  // 4. Beheer › Systeem on the desk laptop: all three laptops, all safe.
  startedAt = performance.now();
  await admin.goto(`${deskUrl}/admin`);
  await admin.locator('.management-navigation').getByText('Systeem & herstel').click();
  const groupState = admin.locator('.cluster-state');
  await groupState.getByText('Alles veilig').waitFor({ timeout: PATIENCE_MS });
  record('Beheer › Systeem shows the group is safe', performance.now() - startedAt, 2_000);
  const peerRows = admin.locator('.cluster-peer-row');
  assert.equal(await peerRows.count(), 3);
  assert.equal(await peerRows.filter({ hasText: '(deze laptop)' }).count(), 1);
  assert.equal(await peerRows.filter({ hasText: 'ordent de wijzigingen' }).count(), 1);
  await tv.waitForFunction(
    (urls) => urls.every((url) => JSON.parse(localStorage.getItem('apolloon.cluster-members') || '[]').includes(url)),
    [timingUrl, deskUrl]
  );

  // With Beheer open, a press is just as fast.
  const secondOnTv = shownAt(tv, '.inside-now__runner', secondWaiting.name);
  const secondPress = await press(timing);
  record('Timing press with Beheer open is confirmed', secondPress.savedMs, 300);
  record('that press reaches the Binnenscherm', (await secondOnTv) - secondPress.at, 500);

  // 5. The leader dies mid-lap and Timing presses straight away: the press waits out the takeover.
  await timing.waitForTimeout(1_000);
  const missingShown = shownAt(admin, '.cluster-state', 'Eén laptop onbereikbaar');
  const killedAt = performance.timeOrigin + performance.now();
  process.kill(leader.pid, 'SIGKILL');
  const takeoverPress = await press(timing);
  record('a press during the takeover is confirmed', takeoverPress.savedMs, 5_000);
  const timingNow = timing.locator('.timing-now');
  await timingNow.getByText(newcomer.name).waitFor();
  assert.deepEqual(
    (await timingNow.locator('.label-pill').allInnerTexts()).map((text) => text.trim()).sort(),
    [speedteam.name, otherLabel.name].sort(),
    'Timing shows the new runner with their labels'
  );
  const takeoverLap = (await laps(timingUrl)).find((lap) => lap.runnerId === secondWaiting.id);
  assert.equal(
    takeoverLap.durationMs,
    Math.round(takeoverPress.eventTime - secondPress.eventTime),
    'the lap ended at the keypress, not when the laptops confirmed it'
  );
  console.log(`PASS the lap across the takeover is timed to the keypress (${takeoverLap.durationMs} ms)`);
  record('Beheer says one laptop is missing', (await missingShown) - killedAt, 8_000);

  // 6. The TV on the dead laptop reopens on another one and shows who is running now.
  await tv.waitForURL((url) => [timingUrl, deskUrl].includes(url.origin) && url.pathname === '/display/inside', {
    timeout: PATIENCE_MS,
  });
  const tvBack = await shownAt(tv, '.inside-now__runner', newcomer.name);
  record('the Binnenscherm reopens on another laptop', tvBack - killedAt, 13_000);
  assert.equal(new URL(timing.url()).origin, timingUrl, 'Timing stays on its own laptop');
  assert.equal(new URL(desk.url()).origin, deskUrl, 'Wachtrij stays on its own laptop');

  // Two laptops are still a majority: queue moves keep working.
  const lateRunner = restWaiting[1];
  const lateOnTiming = shownAt(timing, '.timing-upcoming li', lateRunner.name);
  clickedAt = await clickAt(desk, deskRow(warmupLane, lateRunner.name).getByRole('button', { name: 'Naar wachtrij' }));
  record('a queue move with one laptop down reaches Timing', (await lateOnTiming) - clickedAt, 500);

  // 7. The dead laptop comes back, catches up and the group is whole again.
  startedAt = performance.now();
  restarted = await startServer({
    dataPath: leader.dataPath,
    port: Number(new URL(leaderUrl).port),
    cluster: true,
    discoveryPort,
  });
  await waitUntil(async () => {
    const all = await Promise.all(laptops.map(async ({ url }) => status(url)));
    return all.every((state) => state.state === 'healthy' && state.logHead === all[0].logHead);
  });
  record('the laptop rejoins and has caught up', performance.now() - startedAt, 5_000);
  await groupState.getByText('Alles veilig').waitFor({ timeout: PATIENCE_MS });
  record('Beheer says all is safe again', performance.now() - startedAt, 6_000);

  const tvOnReturned = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await tvOnReturned.goto(`${leaderUrl}/display/inside`);
  await tvOnReturned.locator('.inside-now__runner').getByText(newcomer.name).waitFor({ timeout: PATIENCE_MS });
  const lastOnTv = shownAt(tvOnReturned, '.inside-now__runner', lateRunner.name);
  const lastPress = await press(timing);
  record('Timing press after the rejoin is confirmed', lastPress.savedMs, 300);
  record('that press reaches the Binnenscherm on the returned laptop', (await lastOnTv) - lastPress.at, 500);

  // Every laptop holds the same laps, each once: the three handoffs after the start.
  await waitUntil(async () => {
    const copies = await Promise.all(laptops.map(async ({ url }) => laps(url)));
    return copies.every((copy) => JSON.stringify(copy) === JSON.stringify(copies[0])) && copies[0].length === 3;
  });
  const finalLaps = await laps(firstUrl);
  assert.equal(new Set(finalLaps.map((lap) => lap.id)).size, finalLaps.length);
  assert.deepEqual(finalLaps.map((lap) => lap.runnerId).sort(), [firstWaiting.id, secondWaiting.id, newcomerId].sort());
  console.log('PASS every laptop holds the same three laps, each once');
} finally {
  await browser.close();
  restarted?.process.kill('SIGTERM');
  printTimings();
}

function printTimings() {
  if (!timings.length) return;
  const width = Math.max(...timings.map(({ description }) => description.length));
  console.log('\nrace-day timings');
  for (const { description, ms, budgetMs } of timings) {
    console.log(`  ${description.padEnd(width)}  ${String(ms).padStart(6)} ms  / ${budgetMs} ms`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = timings.map(
      ({ description, ms, budgetMs }) =>
        `| ${description} | ${ms} ms | ${budgetMs} ms | ${ms <= budgetMs ? '✅' : '❌'} |`
    );
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      ['### Race-day walkthrough', '', '| Step | Time | Budget | |', '| --- | ---: | ---: | --- |', ...rows, ''].join(
        '\n'
      ) + '\n'
    );
  }
}
