import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseEnvText, resolveServerAddress } from '../electron/server-config.js';

test('Electron server configuration follows PORT and preserves values containing equals signs', () => {
  const fileEnvironment = parseEnvText(`
    # Local packaged configuration
    PORT=6123
    TOKEN="part=one=part=two"
  `);
  const address = resolveServerAddress(fileEnvironment);

  assert.equal(fileEnvironment.TOKEN, 'part=one=part=two');
  assert.deepEqual(address, {
    port: 6123,
    publicPort: 6123,
    url: 'http://127.0.0.1:6123',
  });
});

test('Electron can advertise a different public port without opening its window on that port', () => {
  assert.deepEqual(
    resolveServerAddress({ PORT: '5173', PUBLIC_APP_PORT: '80' }),
    {
      port: 5173,
      publicPort: 80,
      url: 'http://127.0.0.1:5173',
    }
  );
});

test('desktop release packaging covers every supported platform and verifies native ABI', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    build: Record<string, unknown>;
  };
  const buildScript = fs.readFileSync(path.resolve('scripts/electron-build.mjs'), 'utf8');
  const cleanServerBuildScript = fs.readFileSync(
    path.resolve('scripts/clean-server-build.mjs'),
    'utf8'
  );

  assert.match(packageJson.scripts['electron:build:win'], /--win/);
  assert.match(packageJson.scripts['electron:build:linux'], /--linux/);
  assert.match(packageJson.scripts['electron:build:mac'], /--mac/);
  assert.ok(packageJson.build.win);
  assert.ok(packageJson.build.linux);
  assert.ok(packageJson.build.mac);
  assert.match(buildScript, /--build-from-source/);
  assert.match(buildScript, /--config\.npmRebuild=false/);
  assert.match(buildScript, /node_register_module_v/);
  assert.match(buildScript, /builderArgs\.push\('--publish', 'never'\)/);
  assert.match(packageJson.scripts['server:build'], /clean-server-build\.mjs/);
  assert.match(cleanServerBuildScript, /compiledServerDirectory/);
  assert.match(cleanServerBuildScript, /fs\.promises\.rm/);
});

test('release metadata uses the package version consistently', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
    version: string;
  };
  const packageLock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8')) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  const compatibilitySource = fs.readFileSync(
    path.resolve('server/cluster-compatibility.ts'),
    'utf8'
  );
  const exampleEnvironment = fs.readFileSync(path.resolve('.env.example'), 'utf8');
  const releaseWorkflow = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
  const escapedVersion = packageJson.version.replaceAll('.', '\\.');

  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.match(compatibilitySource, new RegExp(`DEFAULT_APP_VERSION = '${escapedVersion}'`));
  assert.match(exampleEnvironment, new RegExp(`APOLLOON_APP_VERSION=${escapedVersion}`));
  assert.match(releaseWorkflow, new RegExp(`default: v${escapedVersion}`));
});

test('packaged Electron startup clears poisoned assets and never exposes a blank window', () => {
  const mainSource = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');

  assert.match(mainSource, /show: false/);
  assert.match(mainSource, /await window\.webContents\.session\.clearCache\(\)/);
  assert.match(mainSource, /desktopVersion/);
  assert.match(mainSource, /rendererHasContent/);
  assert.match(mainSource, /await createWindow\(\)/);
  assert.match(mainSource, /if \(!window\.isDestroyed\(\)\) window\.show\(\)/);
});

test('the packaged backend exits when its Electron parent disappears', () => {
  const serverSource = fs.readFileSync(path.resolve('server/index.ts'), 'utf8');

  assert.match(serverSource, /process\.once\('disconnect'/);
  assert.match(serverSource, /stopClusterService\(\)/);
  assert.match(serverSource, /closeDb\(\)/);
  assert.match(serverSource, /server\.close\(finish\)/);
});
