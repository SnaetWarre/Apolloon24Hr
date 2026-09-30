import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';

/** A new install, and one upgrading the oldest database a laptop can still have. */
const SCENARIOS = [
  { name: 'fresh', database: null, runners: 0 },
  { name: 'upgrade from v0.7.1', database: path.join('tests', 'fixtures', 'db', 'v0.7.1.sqlite'), runners: 3 },
];

const temporary = mkdtempSync(path.join(tmpdir(), 'apolloon-package-smoke-'));
const { version, build } = JSON.parse(readFileSync('package.json', 'utf8'));
try {
  let executable;
  if (process.platform === 'win32') {
    executable = path.resolve('release', 'win-unpacked', `${build.productName}.exe`);
  } else if (process.platform === 'linux') {
    const images = readdirSync('release').filter((file) => file === `${build.productName}-${version}.AppImage`);
    assert.equal(images.length, 1, 'Expected exactly one AppImage');
    execFileSync(path.resolve('release', images[0]), ['--appimage-extract'], { cwd: temporary, stdio: 'ignore' });
    executable = path.join(temporary, 'squashfs-root', 'AppRun');
  } else {
    throw new Error(`Unsupported smoke test platform: ${process.platform}`);
  }
  for (const [index, scenario] of SCENARIOS.entries()) {
    const dataPath = path.join(temporary, `data-${index}`);
    mkdirSync(dataPath);
    if (scenario.database) {
      mkdirSync(path.join(dataPath, 'data'));
      copyFileSync(scenario.database, path.join(dataPath, 'data', 'app.db'));
    }
    await smoke(executable, dataPath, scenario);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

async function smoke(executable, dataPath, scenario) {
  // Reserve an available port, then release it immediately before starting Electron.
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  writeFileSync(path.join(dataPath, '.env'), `PORT=${port}\nCLUSTER_ENABLED=false\n`);
  const child = spawn(executable, ['--no-sandbox', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, APOLLOON_PACKAGE_SMOKE: '1', APOLLOON_SMOKE_DATA: dataPath },
  });
  const timeout = setTimeout(() => {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child.kill('SIGKILL');
  }, 60_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, `Packaged Electron must exit successfully (${scenario.name})`);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dataPath, 'smoke-result.json'), 'utf8')), {
      version,
      renderer: true,
      database: true,
      runners: scenario.runners,
    });
    console.log(
      `Package smoke passed: ${process.platform}, version ${version}, ${scenario.name}, renderer and SQLite ready`
    );
  } finally {
    clearTimeout(timeout);
  }
}
