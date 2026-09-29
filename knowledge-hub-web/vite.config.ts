import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // In production VITE_API_URL is set to the deployed backend URL in the .env build.
  // In development the proxy below forwards /api → the local backend (used when VITE_API_URL is empty).
  // KH_API_PORT overrides the backend port for when 3000 is taken by another project.
  optimizeDeps: {
    include: ['react-force-graph-2d'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Microsoft sign-in redirects (OneDrive/Alliance) go through the backend too.
      '/auth': {
        target: `http://localhost:${process.env['KH_API_PORT'] ?? '3000'}`,
        changeOrigin: true,
      },
      '/api': {
        target: `http://localhost:${process.env['KH_API_PORT'] ?? '3000'}`,
        changeOrigin: true,
        proxyTimeout: 60_000,
        timeout: 60_000,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.warn('[vite-proxy] backend unreachable:', err.message);
          });
        },
      },
    },
  },
});
