// Runs every browser check against its own freshly seeded, built server (or group of laptops).
// Usage: npm run test:ui (after npm run build). Needs `npx playwright install chromium` once.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, startServer } from './laptop.mjs';

const CHECKS = [
  { name: 'workflow-ui', laptops: 1 },
  { name: 'dialog-ui', laptops: 1 },
  // Linking on, so Systeem & herstel shows its address field.
  { name: 'autofocus-ui', laptops: 1, cluster: true },
  { name: 'theme-ui', laptops: 1 },
  { name: 'recovery-ui', laptops: 1 },
  { name: 'failover-ui', laptops: 3 },
  { name: 'race-day-ui', laptops: 3 },
];
const discoveryPort = 20_000 + (process.pid % 20_000);

// `node scripts/validation/run.mjs failover-ui` runs only the named checks.
const selected = process.argv.slice(2);
for (const check of CHECKS.filter((candidate) => !selected.length || selected.includes(candidate.name))) {
  const laptops = [];
  try {
    for (let index = 0; index < check.laptops; index += 1) {
      laptops.push(
        await startLaptop(`${check.name}-${index}`, { seed: index === 0, cluster: check.cluster ?? check.laptops > 1 })
      );
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
        // Everything a check needs to stop and restart any laptop itself.
        APOLLOON_LAPTOPS: JSON.stringify(
          laptops.map((laptop) => ({ url: laptop.url, dataPath: laptop.dataPath, pid: laptop.process.pid }))
        ),
        APOLLOON_DISCOVERY_PORT: String(discoveryPort),
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
  return startServer({ dataPath, port: await freePort(), cluster, discoveryPort });
}
