import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: API on PORT (e.g. 3000) — see package.json "dev:all"
const apiTarget = `http://127.0.0.1:${process.env.VITE_DEV_API_PORT || 3000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    // Default is loopback only; without this, http://<LAN-IP>:5173 fails on this machine and on other devices
    host: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/socket.io': { target: apiTarget, ws: true, changeOrigin: true },
    },
  },
  preview: {
    host: true,
  },
});


