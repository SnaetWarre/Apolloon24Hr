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
  const home = await fetch(url);
  assert(home.ok, 'WASM index must be served');
  assert((await home.text()).includes('app.js'));
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true }));
  const stateRequest = page.waitForResponse((r) => r.url().endsWith('/api/state') && r.ok(), { timeout: 90000 });
  await page.goto(url);
  await stateRequest;
  await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('#status'), {
    timeout: 90000,
  });
  await page.waitForResponse((r) => r.url().endsWith('/api/state') && r.ok());
  await page.mouse.click(80, 178);
  await page.screenshot({ path: path.join(dir, 'timing-before.png') });
  const press = page.waitForResponse((r) => r.url().endsWith('/api/action/race.handoff'), { timeout: 10000 });
  await page.mouse.click(780, 230);
  const response = await press;
  assert(response.ok(), await response.text());
  const persisted = await (await fetch(url + '/api/state')).json();
  assert.equal(persisted.race.activeRunnerId, runner.id, 'Browser click must start the waiting runner');
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
  await page.screenshot({ path: path.join(dir, 'import-before.png') });
  const picker = page.waitForEvent('filechooser');
  await page.mouse.click(307, 557);
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
  await page.mouse.click(1279, 557);
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
  console.log(
    'PASS: WebGL2 Rune UI renders without WebGPU starts a runner, and imports a CSV with row warnings through real Rust HTTP/SQLite'
  );
} finally {
  if (browser) await browser.close();
  child.kill('SIGTERM');
  if (child.exitCode === null) await once(child, 'exit');
  await writeFile(path.join(dir, 'server.log'), logs);
}
