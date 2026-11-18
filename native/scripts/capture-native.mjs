// Capture the Rune browser screens in both themes from a disposable copy of the supplied database.
// Usage: APOLLOON_CAPTURE_DB=/path/to/app.db node native/scripts/capture-native.mjs [outDir] [route ...]
// Build the Rust server and WASM bundle first.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

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
// APOLLOON_VIEWPORT=1920x1080 captures at another size (default 1366x768).
const [vw, vh] = (process.env.APOLLOON_VIEWPORT ?? '1366x768').split('x').map(Number);
const source = process.env.APOLLOON_CAPTURE_DB;
if (!source) throw new Error('Set APOLLOON_CAPTURE_DB to the SQLite database to copy');
await mkdir(out, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'apolloon-capture-'));
const db = path.join(scratch, 'app.db');
await copyFile(source, db);
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const child = spawn(
  path.resolve(process.env.APOLLOON_NATIVE_BIN ?? 'native/target/debug/apolloon-native'),
  ['--server'],
  {
    env: {
      ...process.env,
      BACKUP_ENABLED: 'false',
      CLUSTER_ENABLED: 'false',
      PORT: String(port),
      APOLLOON_NATIVE_DATA: db,
    },
    stdio: 'ignore',
  }
);
const stopped = once(child, 'exit');
const url = `http://127.0.0.1:${port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url + '/api/health')).ok) break;
    } catch {}
    if (i > 200) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: vw, height: vh }, colorScheme: theme });
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
      await page.waitForTimeout(Number(process.env.APOLLOON_SETTLE_MS ?? 2000));
      await page.screenshot({ path: path.join(out, `native-${theme}-${name}.png`) });
    }
    await page.close();
  }
  console.log(`Screens in ${out}`);
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await stopped;
  await rm(scratch, { recursive: true, force: true });
}
