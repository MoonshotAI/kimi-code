import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

const webPort = Number(process.env.WEB_PORT) || 5175;
// Where the dev proxy forwards server traffic. Defaults to the local server
// (or `pnpm dev:stub`). Override to point dev at another server instance.
const serverTarget = process.env.KIMI_SERVER_URL || 'http://127.0.0.1:58627';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

function apiProxyConfig() {
  return {
    target: serverTarget,
    changeOrigin: true,
    ws: true,
    // Rewrite the WebSocket Origin header to the upstream target so the
    // server's same-origin check passes even when the browser opens the dev UI
    // on `localhost:5175` while the server binds `127.0.0.1`.
    rewriteWsOrigin: true,
  };
}

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // Expose the dev proxy's upstream server target to the client so the UI can
  // show which server it is connected to (the browser otherwise only sees its
  // own same-origin URL). Unused by the same-origin production build.
  define: {
    __KIMI_DEV_PROXY_TARGET__: JSON.stringify(serverTarget),
    __KIMI_WEB_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: webPort,
    strictPort: false,
    // Same-origin dev: the browser calls Vite, Vite forwards to the server.
    // No CORS anywhere. The real server serves REST + WS all under /api/v1.
    proxy: {
      '/api/v1': apiProxyConfig(),
    },
  },
  // `vite preview` (the production build served locally) needs the same proxy —
  // bugs that only exist in production chunking (e.g. optional-peer-dep stubs)
  // can't be reproduced without running the built app against a server.
  preview: {
    port: Number(process.env.WEB_PREVIEW_PORT) || 4175,
    proxy: {
      '/api/v1': apiProxyConfig(),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
