// Starts one built server as a laptop. Shared by run.mjs and checks that restart a laptop themselves.
import { spawn } from 'node:child_process';
import net from 'node:net';

export async function startServer({ dataPath, port, cluster, discoveryPort }) {
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
      CLUSTER_DISCOVERY_PORT: String(discoveryPort),
      // The checks link the laptops with Koppelen themselves.
      CLUSTER_AUTO_LINK: 'false',
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

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
