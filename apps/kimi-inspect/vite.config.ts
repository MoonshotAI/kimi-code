import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

import { serverDiscoveryPlugin } from './vite/serverDiscovery';

const webPort = Number(process.env['INSPECT_PORT']) || 5176;
// Where the dev proxy forwards server traffic. The app can also connect to an
// arbitrary server URL typed into the connect screen (loopback cross-origin is
// allowed by kap-server), but the default connection is same-origin through
// this proxy so no CORS / Origin handling is involved.
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
