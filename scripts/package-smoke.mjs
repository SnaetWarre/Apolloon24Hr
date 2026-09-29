import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';

const temporary = mkdtempSync(path.join(tmpdir(), 'apolloon-package-smoke-'));
const { version, build } = JSON.parse(readFileSync('package.json', 'utf8'));
try {
  // Reserve an available port, then release it immediately before starting Electron.
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  writeFileSync(path.join(temporary, '.env'), `PORT=${port}\nCLUSTER_ENABLED=false\n`);
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
  const child = spawn(executable, ['--no-sandbox', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, APOLLOON_PACKAGE_SMOKE: '1', APOLLOON_SMOKE_DATA: temporary },
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
    assert.equal(code, 0, 'Packaged Electron must exit successfully');
    assert.deepEqual(JSON.parse(readFileSync(path.join(temporary, 'smoke-result.json'), 'utf8')), {
      version,
      renderer: true,
      database: true,
    });
    console.log(`Package smoke passed: ${process.platform}, version ${version}, renderer and SQLite ready`);
  } finally {
    clearTimeout(timeout);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
