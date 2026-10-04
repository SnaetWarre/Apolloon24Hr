import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: the API runs on VITE_DEV_API_PORT (3000 in the dev scripts); Vite proxies to it.
const apiTarget = `http://127.0.0.1:${process.env.VITE_DEV_API_PORT || 3000}`;

export default defineConfig({
  // React Compiler memoizes components and hooks, so they need no hand-written useMemo/useCallback.
  // It skips a function it cannot compile (for example one with try/finally); that function runs unmemoized.
  // `compiler` runs the Rust port of the compiler (oxc-transform-react) instead of the Babel plugin.
  plugins: [react({ compiler: true })],
  cacheDir: '.vite-cache',
  build: {
    chunkSizeWarningLimit: 800,
  },
  server: {
    // Default is loopback only; without this, http://<LAN-IP>:5173 fails on this machine and on other devices
    host: true,
    proxy: {
      '/trpc': { target: apiTarget, ws: true, changeOrigin: true },
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    host: true,
  },
});
