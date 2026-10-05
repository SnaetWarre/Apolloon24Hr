import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const { version, build, name } = JSON.parse(readFileSync('package.json', 'utf8'));

export { version };

/**
 * The packaged app in `release/`: `executable` starts the desktop app, `binary` is the
 * Electron binary itself (for running the bundled server as Node), and `resources`
 * holds app.asar. The Linux AppImage is extracted into `temporary` first.
 */
export function packagedApp(temporary) {
  if (process.platform === 'win32') {
    const root = path.resolve('release', 'win-unpacked');
    const executable = path.join(root, `${build.productName}.exe`);
    return { executable, binary: executable, resources: path.join(root, 'resources') };
  }
  if (process.platform === 'linux') {
    const image = build.linux.artifactName.replace('${version}', version).replace('${ext}', 'AppImage');
    const images = readdirSync('release').filter((file) => file === image);
    assert.equal(images.length, 1, 'Expected exactly one AppImage');
    execFileSync(path.resolve('release', images[0]), ['--appimage-extract'], { cwd: temporary, stdio: 'ignore' });
    const root = path.join(temporary, 'squashfs-root');
    return {
      executable: path.join(root, 'AppRun'),
      binary: path.join(root, build.linux?.executableName ?? name),
      resources: path.join(root, 'resources'),
    };
  }
  throw new Error(`Unsupported package platform: ${process.platform}`);
}
