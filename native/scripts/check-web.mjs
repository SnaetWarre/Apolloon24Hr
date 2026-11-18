// Isolated browser smoke check: force WebGPU unavailable and run Rune through WebGL2.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const dir = path.resolve('.tmp-native-evidence/webgl');
await mkdir(dir, { recursive: true });
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const child = spawn(path.resolve('native/target/debug/apolloon-native'), ['--server'], {
  env: { ...process.env, PORT: String(port), APOLLOON_NATIVE_DATA: path.join(dir, `check-${Date.now()}.db`) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (b) => (logs += b));
child.stderr.on('data', (b) => (logs += b));
let browser;
try {
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url + '/api/health')).ok) break;
    } catch {}
    if (i >= 100) throw new Error(logs);
    await new Promise((r) => setTimeout(r, 50));
  }
  const created = await fetch(url + '/api/action/runners.create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Browser runner', status: 'waiting' }),
  });
  assert(created.ok);
  const runner = await created.json();
  const peerRegistrations = {
    from: 'Second laptop',
    runners: [
      { id: 'peer-duplicate', name: 'browser runner', registration_source: 'manual', created_at: 1 },
      { id: 'peer-runner', name: 'Second laptop runner', registration_source: 'import', created_at: 1 },
    ],
    labels: [],
    labelImages: [],
    runnerLabels: [],
  };
  const merge = () =>
    fetch(url + '/api/action/runners.merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(peerRegistrations),
    });
  const merged = await merge();
  assert(merged.ok);
  assert.deepEqual(await merged.json(), { added: 1, same: 1, labels: 0 });
  const backup = await fetch(url + '/api/action/backups.create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert(backup.ok, await backup.text());
  const home = await fetch(url);
  assert(home.ok, 'WASM index must be served');
  assert((await home.text()).includes('app.js'));
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true });
    const localNow = Date.now.bind(Date);
    Date.now = () => localNow() + 45_000;
  });
  const stateRequest = page.waitForResponse((r) => r.url().endsWith('/api/state') && r.ok(), { timeout: 90000 });
  await page.goto(url);
  await stateRequest;
  await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('#status'), {
    timeout: 90000,
  });
  await page.waitForResponse((r) => r.url().endsWith('/api/state') && r.ok());
  // Rune paints the first frames on the CPU, then hands over to WebGL2 (no WebGPU here).
  await page.waitForFunction(() => performance.getEntriesByName('web.handover.done').length > 0, null, {
    timeout: 30000,
  });
  const gl = await page.evaluate(() => document.querySelectorAll('canvas').length);
  assert.equal(gl, 1, 'After the hand-over only the WebGL2 canvas remains');
  console.log('Rune draws through WebGL2 (web.handover.done)');
  const frame = await page.screenshot();
  const color = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(1330, 710, 1, 1).data);
  }, frame.toString('base64'));
  assert.deepEqual(color, [26, 26, 26, 255], 'WebGL2 retains the reference dark background after handover');
  await page.mouse.click(80, 178);
  await page.screenshot({ path: path.join(dir, 'timing-before.png') });
  const press = page.waitForResponse((r) => r.url().endsWith('/api/action/race.handoff'), { timeout: 10000 });
  await page.mouse.click(780, 335);
  const response = await press;
  assert(response.ok(), await response.text());
  const { pressedAt } = response.request().postDataJSON();
  // SwiftShader's software WebGL2 takes ~0.5 s a frame here, which blurs the clock sample by
  // a second or so; the 45 s skew is what this checks.
  assert(
    Math.abs(pressedAt - Date.now()) < 6000,
    'Timing uses the server clock even when the browser clock is 45 seconds fast'
  );

  const persisted = await (await fetch(url + '/api/state')).json();
  assert.equal(persisted.race.activeRunnerId, runner.id, 'Browser click must start the waiting runner');
  const blockedMerge = await merge();
  assert.equal(blockedMerge.status, 409, 'An active first lap blocks merging even with no recorded laps');
  await writeFile(path.join(dir, 'state-after.json'), JSON.stringify(persisted, null, 2));
  await page.screenshot({ path: path.join(dir, 'webgl.png') });
  const recoveryRequest = page.waitForResponse((r) => r.url().endsWith('/api/recovery') && r.ok());
  await page.goto(url + '/admin?section=system');
  await recoveryRequest;
  await page.waitForResponse((r) => r.url().endsWith('/api/state') && r.ok());
  await page.screenshot({ path: path.join(dir, 'recovery-before.png') });
  await page.goto(url + '/admin?section=preparation');
  await page.waitForResponse((r) => r.url().endsWith('/api/recovery') && r.ok());
  await page.waitForResponse((r) => r.url().endsWith('/api/state') && r.ok());
  await page.waitForFunction(() => performance.getEntriesByName('web.handover.done').length > 0, null, {
    timeout: 30000,
  });
  await page.screenshot({ path: path.join(dir, 'import-before.png') });
  // The page fades in after navigation. Let the button finish entering before pressing it.
  await page.mouse.move(307, 586);
  await page.waitForTimeout(1200);
  const picker = page.waitForEvent('filechooser', { timeout: 15000 });
  await page.mouse.click(307, 586, { delay: 120 });
  const chooser = await picker.catch(async (e) => {
    await page.screenshot({ path: path.join(dir, 'import-click-failed.png') });
    throw e;
  });
  await chooser.setFiles({
    name: 'inschrijvingen.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('nummer,naam,labels\n77,Browser Imported,Dames\n78,'),
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(dir, 'import-picked.png') });
  const importing = page.waitForResponse((r) => r.url().endsWith('/api/action/runners.importCsv'));
  await page.mouse.click(1279, 586);
  const imported = await importing;
  assert(imported.ok(), await imported.text());
  assert.deepEqual(await imported.json(), {
    created: 1,
    updated: 0,
    skipped: 1,
    errors: ['Rij 3: lopersnummer en naam ontbreekt'],
  });
  await page.waitForResponse((r) => r.url().endsWith('/api/state') && r.ok());
  const afterImport = await (await fetch(url + '/api/state')).json();
  assert(afterImport.runners.some((r) => r.name === 'Browser Imported' && r.runnerNumber === '77'));
  await page.screenshot({ path: path.join(dir, 'import-after.png') });
  await writeFile(path.join(dir, 'browser-errors.json'), JSON.stringify(errors, null, 2));
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: WebGL2 timing and CSV import, plus pre-race merge and first-lap protection over Rust HTTP/SQLite');
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  if (child.exitCode === null) await once(child, 'exit');
  await writeFile(path.join(dir, 'server.log'), logs);
}
