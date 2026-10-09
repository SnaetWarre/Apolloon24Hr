// Types into the Tactiek number fields with the real keyboard, the way an operator does.
// Run against a disposable server seeded with a live race; uses the same environment variables as workflow-ui.mjs.
import assert from 'node:assert/strict';

const baseUrl = process.env.APOLLOON_TEST_URL;
assert.ok(baseUrl && ['127.0.0.1', 'localhost'].includes(new URL(baseUrl).hostname));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });

async function typeInto(field, text, leaveWith = 'Tab') {
  await field.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text, { delay: 30 });
  await page.keyboard.press(leaveWith);
  return field.inputValue();
}

try {
  await page.goto(`${baseUrl}/tactics`);
  await page.getByText('Geldige rondes').waitFor();

  // The first digit of 60 is below the minimum of 10; it must not become 10 while typing.
  assert.equal(await typeInto(page.getByLabel('Kortste (s)'), '60'), '60');
  assert.equal(await typeInto(page.getByLabel('Langste (s)'), '180'), '180');
  assert.equal(await typeInto(page.getByLabel('Rondes voor huidig tempo'), '30'), '30');
  const goal = page.getByLabel(/^Rondes na 24 uur/);
  assert.equal(await typeInto(goal, '1200'), '1200');
  await page.getByText('Doeltempo per uur aanpassen').click();
  const firstHour = page.locator('.tactics-hourly-grid input').first();
  assert.equal(await typeInto(firstHour, '85'), '85');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('apolloon.kobe-tactics.scenario.v1')));
  assert.equal(stored.targetLaps, 1200);
  assert.equal(stored.targetPaces[0], 85);
  console.log('PASS Tactiek number fields keep the number typed and store it in the scenario');

  // Out-of-range values are corrected when the field is left or Enter is pressed.
  assert.equal(await typeInto(page.getByLabel('Kortste (s)'), '5'), '10');
  assert.equal(await typeInto(page.getByLabel('Langste (s)'), '400', 'Enter'), '300');
  // A cleared field stays empty while typing and falls back to the last value when left empty.
  await goal.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  assert.equal(await goal.inputValue(), '');
  await page.keyboard.press('Tab');
  assert.equal(await goal.inputValue(), '1200');
  console.log('PASS Tactiek number fields correct out-of-range or empty input on Tab or Enter');

  await page.getByRole('button', { name: 'Analyse vorig jaar', exact: true }).click();
  await page.getByRole('button', { name: /^Diagnostiek/ }).click();
  assert.equal(await typeInto(page.getByLabel('Trage ronde vanaf'), '60'), '60');
  await page.getByRole('button', { name: /^Raceverloop/ }).click();
  const lapLength = page.locator('.tactics-stat--control input');
  await lapLength.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  assert.equal(await lapLength.inputValue(), '');
  await page.keyboard.type('400', { delay: 30 });
  await page.keyboard.press('Tab');
  assert.equal(await lapLength.inputValue(), '400');
  await page.getByText('400 meter per ronde', { exact: true }).waitFor();
  console.log('PASS Analyse vorig jaar number fields keep the number typed');
} finally {
  await browser.close();
}
