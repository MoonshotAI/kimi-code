import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { serverDiscoveryPlugin } from './vite/serverDiscovery';

const webPort = Number(process.env['INSPECT_PORT']) || 5176;
const serverTarget = process.env['KIMI_SERVER_URL'] || 'http://127.0.0.1:58627';

export default defineConfig({
  plugins: [react(), tailwindcss(), serverDiscoveryPlugin({ proxyTarget: serverTarget })],
  define: {
    __KIMI_INSPECT_PROXY_TARGET__: JSON.stringify(serverTarget),
  },
  server: {
    port: webPort,
    strictPort: false,
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true, ws: true },
    },
  },
  preview: {
    port: Number(process.env['INSPECT_PREVIEW_PORT']) || 4176,
    proxy: {
      '/api': { target: serverTarget, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
