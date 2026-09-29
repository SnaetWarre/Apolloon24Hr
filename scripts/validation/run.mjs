// Runs every browser check against its own freshly seeded, built server.
// Usage: npm run test:ui (builds first). Needs `npx playwright install chromium` once.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const CHECKS = ['workflow-ui', 'dialog-ui', 'theme-ui'];

for (const check of CHECKS) {
  const dataPath = path.resolve('.test-data', `ui-${check}`);
  fs.rmSync(dataPath, { recursive: true, force: true });
  execFileSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/seed-test-db.mjs', '--scenario=ready', `--data-path=${dataPath}`],
    {
      stdio: 'ignore',
    }
  );

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATA_PATH: dataPath,
      PORT: String(port),
      CLUSTER_ENABLED: 'false',
      BACKUP_ENABLED: 'false',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForServer(baseUrl, server);
    console.log(`\n${check}`);
    execFileSync(process.execPath, [path.join('scripts', 'validation', `${check}.mjs`)], {
      env: { ...process.env, APOLLOON_TEST_URL: baseUrl },
      stdio: 'inherit',
    });
  } finally {
    server.kill('SIGTERM');
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server stopped with exit code ${child.exitCode}`);
    if ((await fetch(`${baseUrl}/api/host-info`).catch(() => null))?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server at ${baseUrl} did not start`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
