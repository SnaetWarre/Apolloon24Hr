// Runs every browser check against its own freshly seeded, built server (or group of laptops).
// Usage: npm run test:ui (after npm run build). Needs `npx playwright install chromium` once.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const CHECKS = [
  { name: 'workflow-ui', laptops: 1 },
  { name: 'dialog-ui', laptops: 1 },
  { name: 'theme-ui', laptops: 1 },
  { name: 'failover-ui', laptops: 3 },
];

// `node scripts/validation/run.mjs failover-ui` runs only the named checks.
const selected = process.argv.slice(2);
for (const check of CHECKS.filter((candidate) => !selected.length || selected.includes(candidate.name))) {
  const laptops = [];
  try {
    for (let index = 0; index < check.laptops; index += 1) {
      laptops.push(await startLaptop(`${check.name}-${index}`, { seed: index === 0, cluster: check.laptops > 1 }));
    }
    console.log(`\n${check.name}`);
    execFileSync(process.execPath, [path.join('scripts', 'validation', `${check.name}.mjs`)], {
      env: {
        ...process.env,
        APOLLOON_TEST_URL: laptops[0].url,
        APOLLOON_OTHER_URLS: laptops
          .slice(1)
          .map((laptop) => laptop.url)
          .join(','),
        APOLLOON_TEST_PID: String(laptops[0].process.pid),
      },
      stdio: 'inherit',
    });
  } finally {
    for (const laptop of laptops) {
      laptop.process.kill('SIGTERM');
      fs.rmSync(laptop.dataPath, { recursive: true, force: true });
    }
  }
}

async function startLaptop(name, { seed, cluster }) {
  const dataPath = path.resolve('.test-data', `ui-${name}`);
  fs.rmSync(dataPath, { recursive: true, force: true });
  if (seed) {
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/seed-test-db.mjs', '--scenario=ready', `--data-path=${dataPath}`],
      { stdio: 'ignore' }
    );
  }
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATA_PATH: dataPath,
      PORT: String(port),
      CLUSTER_ENABLED: cluster ? 'true' : 'false',
      CLUSTER_SELF_URL: url,
      // Laptops on one machine announce themselves on loopback.
      CLUSTER_DISCOVERY_ADDRESS: '127.255.255.255',
      CLUSTER_DISCOVERY_PORT: String(20_000 + (process.pid % 20_000)),
      BACKUP_ENABLED: 'false',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitForServer(url, child);
  return { url, dataPath, process: child };
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
