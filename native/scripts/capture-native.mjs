// Screenshot the native WASM UI on the same routes and data as capture-reference.mjs, for side-by-side review.
// Usage: node native/scripts/capture-native.mjs [outDir] [route-name ...]
// Needs a built server (cargo build --bin apolloon-native) and web bundle (native/scripts/build-web.sh).
// Data: a fresh copy of .tmp-native-evidence/native-reference/app.db (the live-race reference database).
// Names match .tmp-verify-evidence/native-reference/NN-reference-<theme>-<name>.png.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const routes = [
  ['overview', '/'],
  ['queue', '/queue'],
  ['timing', '/timing'],
  ['analysis', '/analysis'],
  ['tactics', '/tactics'],
  ...['preparation', 'runners', 'laps', 'labels', 'public', 'activity', 'system'].map((s) => [
    `admin-${s}`,
    `/admin?section=${s}`,
  ]),
  ['inside', '/display/inside'],
  ['competitions', '/display/competitions'],
  ['outside', '/display/outside'],
];
const out = path.resolve(process.argv[2] ?? '.tmp-native-evidence/native-screens');
const only = process.argv.slice(3);
await mkdir(out, { recursive: true });
const db = path.join(out, `app-${process.pid}.db`);
await copyFile(path.resolve('.tmp-native-evidence/native-reference/app.db'), db);
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const child = spawn(
  path.resolve(process.env.APOLLOON_NATIVE_BIN ?? 'native/target/debug/apolloon-native'),
  ['--server'],
  {
    env: { ...process.env, BACKUP_ENABLED: 'false', PORT: String(port), APOLLOON_NATIVE_DATA: db },
    stdio: 'ignore',
  }
);
const url = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url + '/api/health')).ok) break;
    } catch {}
    if (i > 200) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, colorScheme: theme });
    await page.addInitScript(() =>
      Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true })
    );
    await page.addInitScript((theme) => localStorage.setItem('apolloon.theme', theme), theme);
    for (const [name, route] of routes) {
      if (only.length && !only.includes(name)) continue;
      await page.goto(url + route);
      await page.waitForFunction(() => document.querySelector('canvas') && !document.querySelector('#status'), {
        timeout: 90000,
      });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(out, `native-${theme}-${name}.png`) });
    }
    await page.close();
  }
  console.log(`Screens in ${out}`);
} finally {
  await browser.close();
  child.kill();
}
