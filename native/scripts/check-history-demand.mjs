import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const out = resolve('.tmp-bench/history-demand-' + new Date().toISOString().replaceAll(':', '-'));
await mkdir(out, { recursive: true });
const db = join(out, 'app.db');
execFileSync('python3', [
  '-c',
  `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.executescript(open(sys.argv[2]).read());c.execute('PRAGMA user_version=17');c.execute('INSERT INTO race_state(id) VALUES(1)')
for i,name in enumerate(['Alpha','Beta']):
 c.execute("INSERT INTO runners(id,runner_number,name,status,queue_index,status_since,created_at,updated_at) VALUES(?,?,?,'waiting',?,0,0,0)",(name.lower(),str(i+1),name,i))
for i in range(24):
 c.execute("INSERT INTO laps(id,runner_id,lap_number,started_at,finished_at,duration_ms,source,created_at,labels_json) VALUES(?,?,?,?,?,60000,'spacebar',?,'[]')",(f'lap-{i}','alpha' if i%2==0 else 'beta',i//2+1,i*60000,(i//2+1)*120000,i))
c.commit()
`,
  db,
  resolve('native/src/schema.sql'),
]);
const listener = createServer().listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const url = `http://127.0.0.1:${port}`;
const child = spawn(resolve('native/target/release/apolloon-native'), ['--server'], {
  env: {
    ...process.env,
    PORT: String(port),
    APOLLOON_NATIVE_DATA: db,
    CLUSTER_ENABLED: 'false',
    BACKUP_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '',
  browser;
for (const s of [child.stdout, child.stderr]) s.on('data', (x) => (log += x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, label) {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return;
    await sleep(50);
  }
  throw Error('timeout: ' + label);
}
async function action(method, input) {
  const r = await fetch(url + '/api/action/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert(r.ok, await r.clone().text());
  return r.json();
}
async function page() {
  const p = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  p.on('pageerror', (e) => console.error(e));
  p.on('console', (m) => {
    if (m.type() === 'error') console.error(m.text());
  });
  p.on('response', async (r) => {
    if (r.url().includes('/api/'))
      try {
        const v = await r.json();
        if (v.unchanged) return;
        await writeFile(
          join(
            out,
            'latest-' + new URL(r.url()).pathname.replaceAll('/', '_') + (v.stateHistory?.scope ?? '') + '.json'
          ),
          JSON.stringify(v, null, 2)
        );
      } catch {}
  });
  await p.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true });
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      if (['webgl', 'webgl2', 'experimental-webgl'].includes(kind)) return null;
      return get.call(this, kind, ...args);
    };
  });
  return p;
}
async function ready(p, admin = false) {
  let registrations = false;
  const initialized = p.waitForResponse((r) => {
    const u = new URL(r.url());
    if (u.pathname === '/api/action/runners.registrations' && r.ok()) registrations = true;
    return registrations && u.pathname === '/api/state' && r.ok() && !u.searchParams.has('after');
  });
  await p.goto(url + (admin ? '/admin?section=runners' : '/queue'));
  await (await initialized).finished();
  await p.getByRole('button', { name: admin ? 'Alpha' : 'Alpha: profiel openen', exact: true }).waitFor();
  await p.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function navigate(p, path) {
  await p.evaluate((path) => {
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await p.keyboard.press('Tab');
}
const dialog = (p) => p.getByRole('dialog', { name: 'Lopersprofiel', exact: true });
try {
  await eventually(async () => {
    try {
      return (await fetch(url + '/api/health')).ok;
    } catch {
      return false;
    }
  }, 'server');
  browser = await chromium.launch({
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  {
    await action('runners.update', {
      id: 'alpha',
      fields: {
        registrationDetails: { phone: '0471', email: 'queue@example.be', availableHours: ['20-21u (dinsdag)'] },
      },
    });
    const before = (await action('runners.profile', { id: 'alpha' })).registration;
    const p = await page();
    let requested = false,
      release;
    const gate = new Promise((r) => (release = r));
    await p.route('**/api/state?**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('historyScope') === 'runner') {
        requested = true;
        await gate;
      }
      await route.continue();
    });
    await ready(p);
    await p.getByRole('button', { name: 'Alpha: profiel openen', exact: true }).click({ force: true });
    await eventually(() => requested, 'Queue runner subscription');
    assert.equal(await dialog(p).count(), 0);
    release();
    await dialog(p).waitFor();
    assert.equal(await dialog(p).getByText('Nog geen rondes geregistreerd.', { exact: true }).count(), 0);
    const full = await page();
    await full.route('**/api/state?**', async (route) => {
      const u = new URL(route.request().url());
      for (const key of ['historyScope', 'historyLimit', 'historyRunnerId']) u.searchParams.delete(key);
      await route.continue({ url: u.href });
    });
    if (process.env.HISTORY_BASE_ASSETS) {
      for (const file of ['app.js', 'app_bg.wasm'])
        await full.route('**/' + file, async (route) =>
          route.fulfill({
            body: await readFile(join(process.env.HISTORY_BASE_ASSETS, file)),
            contentType: file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
          })
        );
    }
    await ready(full);
    await full.getByRole('button', { name: 'Alpha: profiel openen', exact: true }).click({ force: true });
    await dialog(full).waitFor();
    const stable = (text) => text.replace(/voor [\d:]+/g, 'voor CLOCK');
    assert.equal(stable(await dialog(p).innerText()), stable(await dialog(full).innerText()));
    await full.close();
    await p.screenshot({ path: join(out, 'queue-scoped-profile.png') });
    const label = await dialog(p).getByText('Naam', { exact: true }).boundingBox();
    await p.mouse.click(label.x + 40, label.y + label.height + 20);
    await p.locator('textarea[aria-label="Naam"]').waitFor({ state: 'attached' });
    await p.keyboard.press('End');
    await p.keyboard.type(' edited');
    await p.waitForTimeout(150);
    await p.mouse.move(800, 600);
    await p.mouse.wheel(0, 1800);
    await p.waitForTimeout(150);
    await dialog(p).getByRole('button', { name: 'Opslaan', exact: true }).click({ force: true });
    await dialog(p).waitFor({ state: 'hidden' });
    assert.deepEqual((await action('runners.profile', { id: 'alpha' })).registration, before);
    await action('runners.update', { id: 'alpha', fields: { name: 'Alpha' } });
    await p.unrouteAll({ behavior: 'ignoreErrors' });
    await p.close();
    console.log(
      'PASS: Queue waits for runner history, matches full-history main laps/stats, and preserves contact details on save'
    );
  }
  {
    const p = await page();
    let requested = false,
      release;
    const gate = new Promise((r) => (release = r));
    await p.route('**/api/state?**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('historyScope') === 'runner') {
        requested = true;
        await gate;
      }
      await route.continue();
    });
    await ready(p, true);
    await p.getByRole('button', { name: 'Alpha', exact: true }).click({ force: true });
    await eventually(() => requested, 'runner subscription');
    assert.equal(await dialog(p).count(), 0);
    release();
    await dialog(p).waitFor();
    assert.equal(await dialog(p).getByText('Nog geen rondes geregistreerd.', { exact: true }).count(), 0);
    await p.screenshot({ path: join(out, 'scoped-profile.png') });
    await p.unrouteAll({ behavior: 'ignoreErrors' });
    await p.close();
    console.log('PASS: Beheer profile waits for bounded runner history before opening, without empty statistics');
  }
  for (const admin of [false, true]) {
    const p = await page();
    let fullFetch = false;
    p.on('request', (r) => {
      if (r.url().includes('/api/history?scope=full')) fullFetch = true;
    });
    await p.route('**/api/state?**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('historyScope') === 'runner')
        await route.fulfill({ status: 503, json: { error: { message: 'injected failure' } } });
      else await route.continue();
    });
    await ready(p, admin);
    await p
      .getByRole('button', { name: admin ? 'Alpha' : 'Alpha: profiel openen', exact: true })
      .click({ force: true });
    await dialog(p).waitFor();
    assert(fullFetch);
    assert.equal(await dialog(p).getByText('Nog geen rondes geregistreerd.', { exact: true }).count(), 0);
    await p.unrouteAll({ behavior: 'ignoreErrors' });
    await p.close();
    console.log(
      `PASS: failed ${admin ? 'Beheer' : 'Queue'} runner subscription falls back to full history before opening the profile`
    );
  }
  {
    const p = await page();
    const snapshots = [];
    p.on('response', async (r) => {
      if (r.url().includes('/api/state?'))
        try {
          snapshots.push({ path: r.url(), body: await r.json() });
        } catch {}
    });
    await ready(p);
    assert(snapshots.some((s) => s.body.historyScope === 'none' && !s.body.stateHistory));
    await navigate(p, '/analysis');
    await eventually(() => snapshots.some((s) => s.body.stateHistory?.scope === 'full'), 'lean to full');
    const upgrade = snapshots.find((s) => s.body.stateHistory?.scope === 'full');
    assert(!new URL(upgrade.path).searchParams.has('after'));
    await navigate(p, '/queue');
    await action('runners.update', { id: 'alpha', fields: { notes: 'after full' } });
    await eventually(() => snapshots.some((s) => s.body.stateHistory?.delta === true), 'sticky full delta');
    const delta = snapshots.find((s) => s.body.stateHistory?.delta === true);
    assert.equal(delta.body.stateHistory.changes.laps.count, 24);
    assert(!new URL(delta.path).searchParams.has('historyScope'));
    await p.close();
    console.log('PASS: lean to full bypasses unchanged markers; full to lean retains all rows and delta polling');
  }
  {
    const p = await page();
    let full = false;
    await p.route('**/api/state?**', async (route) => {
      const u = new URL(route.request().url());
      for (const key of ['historyScope', 'historyLimit', 'historyRunnerId']) u.searchParams.delete(key);
      await route.continue({ url: u.href });
    });
    p.on('response', async (r) => {
      if (r.url().includes('/api/state?'))
        try {
          if ((await r.json()).stateHistory?.scope === 'full') full = true;
        } catch {}
    });
    await ready(p, true);
    await eventually(() => full, 'old server full fallback');
    await p.getByRole('button', { name: 'Alpha', exact: true }).click({ force: true });
    await dialog(p).waitFor();
    await p.unrouteAll({ behavior: 'ignoreErrors' });
    await p.close();
    console.log('PASS: scope-unaware server retains full history and opens the unchanged profile');
  }
  {
    await action('runners.update', { id: 'alpha', fields: { registrationDetails: { email: 'old@example.be' } } });
    const p = await page();
    let profiles = 0,
      registrations = 0;
    p.on('request', (r) => {
      if (r.url().includes('/api/action/runners.profile')) profiles++;
      if (r.url().includes('/api/action/runners.registrations')) registrations++;
    });
    await ready(p, true);
    await p.getByRole('button', { name: 'Alpha', exact: true }).click({ force: true });
    await dialog(p).waitFor();
    const before = { profiles, registrations };
    await action('runners.update', {
      id: 'alpha',
      fields: { name: 'Updated Alpha', registrationDetails: { email: 'new@example.be' } },
    });
    await eventually(
      async () =>
        registrations > before.registrations &&
        (await dialog(p).getByRole('heading', { name: '1 Updated Alpha', exact: true }).count()),
      'registration refresh after remote profile edit'
    );
    assert(profiles - before.profiles <= 3, `profile reload storm: ${profiles - before.profiles}`);
    assert.equal(await dialog(p).getByText('Nieuwste profiel laden', { exact: true }).count(), 0);
    const label = await dialog(p).getByText('E-mail', { exact: true }).boundingBox();
    await p.mouse.click(label.x + 40, label.y + label.height + 20);
    await eventually(async () => (await p.locator('textarea[aria-label="E-mail"]').count()) > 0, 'email focus');
    assert.equal(await p.locator('textarea[aria-label="E-mail"]').inputValue(), 'new@example.be');
    await p.waitForTimeout(200);
    await p.mouse.move(800, 600);
    await p.mouse.wheel(0, 1800);
    await p.waitForTimeout(150);
    const saved = p.waitForResponse((r) => r.url().includes('/api/action/runners.update') && r.ok());
    await dialog(p).getByRole('button', { name: 'Opslaan', exact: true }).click({ force: true });
    await saved;
    await dialog(p).waitFor({ state: 'hidden' });
    assert.equal((await action('runners.profile', { id: 'alpha' })).registration.email, 'new@example.be');
    await p.close();
    console.log(
      'PASS: lean Beheer profile follows remote name/email edits without starving registration refresh or disabling save'
    );
  }
  console.log('Evidence: ' + out);
} catch (error) {
  for (const [i, p] of browser
    .contexts()
    .flatMap((c) => c.pages())
    .entries()) {
    await p.screenshot({ path: join(out, `failure-${i}.png`) });
    await writeFile(join(out, `failure-${i}.txt`), await p.locator('body').innerText());
  }
  console.error('Evidence: ' + out);
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  await writeFile(join(out, 'server.log'), log);
}
