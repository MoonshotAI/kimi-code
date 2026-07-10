import { defineConfig } from 'vite';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const webPort = Number(process.env.WEB_PORT) || 5175;
// Where the dev proxy forwards server traffic. Defaults to the local server
// (or `pnpm dev:stub`). Override to point dev at another server instance.
const serverTarget = process.env.KIMI_SERVER_URL || 'http://127.0.0.1:58627';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

// Shared renderer config (Vue + unplugin-icons `kimi` collection, ES2022 target,
// module workers, `__KIMI_*` defines) lives in `@moonshot-ai/vite-preset` so the
// web and desktop renderers stay in lockstep. Web-only concerns (dev/preview
// proxy, build output dir) are layered on top below.
const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  iconsDir: fileURLToPath(new URL('./src/icons/kimi', import.meta.url)),
  // Expose the dev proxy's upstream server target to the client so the UI can
  // show which server it is connected to (the browser otherwise only sees its
  // own same-origin URL). Unused by the same-origin production build.
  defines: {
    __KIMI_DEV_PROXY_TARGET__: JSON.stringify(serverTarget),
    __KIMI_WEB_VERSION__: JSON.stringify(pkg.version),
    // True only for the web bundle embedded in the Kimi Desktop app (set by the
    // desktop-build workflow). Gates an "internal testing build" banner. When
    // false (default) the banner is tree-shaken out of the production bundle.
    __KIMI_WEB_DESKTOP__: JSON.stringify(process.env.KIMI_WEB_DESKTOP === '1'),
  },
});

export default defineConfig({
  ...preset,
  build: {
    ...preset.build,
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: webPort,
    strictPort: false,
    // Same-origin dev: the browser calls Vite, Vite forwards to the server.
    // No CORS anywhere. The real server serves REST + WS all under /api/v1.
    proxy: {
      '/api/v1': { target: serverTarget, changeOrigin: true, ws: true },
    },
  },
  // `vite preview` (the production build served locally) needs the same proxy —
  // bugs that only exist in production chunking (e.g. optional-peer-dep stubs)
  // can't be reproduced without running the built app against a server.
  preview: {
    port: Number(process.env.WEB_PREVIEW_PORT) || 4175,
    proxy: {
      '/api/v1': { target: serverTarget, changeOrigin: true, ws: true },
    },
  },
});
