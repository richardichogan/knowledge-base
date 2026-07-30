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
  // In development the proxy below forwards /api → localhost:3000 (used when VITE_API_URL is empty).
  optimizeDeps: {
    include: ['react-force-graph-2d'],
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3010',
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
