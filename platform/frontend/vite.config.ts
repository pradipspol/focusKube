import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:4000';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: [
      'prapol2l.ptcnet.ptc.com' // Explicitly allows your specific host
    ],
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND, changeOrigin: true, ws: true },
    },
  },
});
