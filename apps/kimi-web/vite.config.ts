import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { FileSystemIconLoader } from 'unplugin-icons/loaders';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

const webPort = Number(process.env.WEB_PORT) || 5175;
// Dev-proxy backend presets: `default` is the kap-server started by the root
// `pnpm dev:server` (port 58627); `multi` is a second kap-server instance
// started with `pnpm dev:v2` (KIMI_CODE_EXPERIMENTAL_MULTI_SERVER=1, port
// 58628) for multi-instance debugging. Override with KIMI_BACKEND_DEFAULT_URL
// / KIMI_BACKEND_MULTI_URL.
const backendPresets = {
  default: process.env.KIMI_BACKEND_DEFAULT_URL || 'http://127.0.0.1:58627',
  multi: process.env.KIMI_BACKEND_MULTI_URL || 'http://127.0.0.1:58628',
} as const;
type BackendName = keyof typeof backendPresets;
// Where the dev proxy forwards server traffic. Defaults to the `default`
// preset; KIMI_SERVER_URL pins the initial target (and disables nothing — the
// dev switcher can still move it at runtime).
const serverTarget = process.env.KIMI_SERVER_URL || backendPresets.default;
// Mutable proxy target. Vite copies its proxy-options object per HTTP request
// and reads it directly per WS upgrade, so assigning `target` on the captured
// options repoints the proxy without a dev-server restart (see the plugin).
let currentBackendTarget = serverTarget;
let backendProxyOpts: { target?: unknown } | null = null;
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

/**
 * Dev-only backend switcher. Two endpoints let the web UI read and move the
 * proxy target at runtime (the Sidebar badge menu POSTs here, then reloads):
 *   GET  /__kimi-dev/backend           → { current, presets }
 *   POST /__kimi-dev/backend { name }  → switch to presets[name]
 * Preview keeps the static proxy below — this only hooks the dev server.
 */
function backendSwitcherPlugin(): Plugin {
  const sendJson = (res: ServerResponse, body: unknown): void => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const state = (): { current: string; presets: typeof backendPresets } => ({
    current: currentBackendTarget,
    presets: backendPresets,
  });
  const switchTo = (name: BackendName): void => {
    currentBackendTarget = backendPresets[name];
    // Repoint the live proxy. NOTE: vite's vendored http-proxy has no
    // `router` support — mutating the captured options object is the switch.
    if (backendProxyOpts) backendProxyOpts.target = currentBackendTarget;
  };
  return {
    name: 'kimi-backend-switcher',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.url !== '/__kimi-dev/backend') return next();
        if (req.method === 'GET') {
          sendJson(res, state());
          return;
        }
        if (req.method === 'POST') {
          let raw = '';
          req.on('data', (chunk: Buffer) => (raw += chunk));
          req.on('end', () => {
            let name: unknown;
            try {
              name = (JSON.parse(raw) as { name?: unknown }).name;
            } catch {
              name = undefined;
            }
            if (name !== 'default' && name !== 'multi') {
              res.statusCode = 400;
              sendJson(res, { error: 'expected { "name": "default" | "multi" }' });
              return;
            }
            switchTo(name as BackendName);
            sendJson(res, state());
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

// Shared proxy behavior for dev AND preview. `configure` does two things:
//   1. captures vite's live proxy-options object so the dev backend switcher
//      can repoint `target` at runtime (vite's vendored http-proxy ignores
//      `router`; a fresh copy of this object is consulted per HTTP request,
//      and the object itself per WS upgrade);
//   2. strips the browser `Origin` header on the forwarded request. The proxy
//      rewrites `Host` to the server (changeOrigin) but leaves `Origin`
//      pointing at the Vite origin — and kap-server's WS upgrade path
//      rejects any present Origin whose host ≠ Host with 403. An Origin-less
//      request is treated as a non-browser client (and the browser never
//      needs CORS here: it talks to its own origin).
const apiProxyOptions = {
  target: serverTarget,
  changeOrigin: true,
  ws: true,
  configure: (
    proxy: {
      on(
        event: string,
        listener: (proxyReq: { removeHeader(name: string): void }) => void,
      ): unknown;
    },
    options: { target?: unknown },
  ) => {
    backendProxyOpts = options;
    proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'));
    proxy.on('proxyReqWs', (proxyReq) => proxyReq.removeHeader('origin'));
  },
};

export default defineConfig({
  plugins: [
    vue(),
    backendSwitcherPlugin(),
    Icons({
      compiler: 'vue3',
      // Local Kimi Design System icons (24×24 outlined, fill="currentColor"),
      // copied from the design-system icon pack into src/icons/kimi/ and
      // imported as `~icons/kimi/<file-name>` (plus `?raw`), same as the ri
      // collection. Registered in src/lib/icons.ts only.
      customCollections: {
        kimi: FileSystemIconLoader(fileURLToPath(new URL('./src/icons/kimi', import.meta.url))),
      },
    }),
  ],
  // Expose the dev proxy's upstream server target to the client so the UI can
  // show which server it is connected to (the browser otherwise only sees its
  // own same-origin URL). Unused by the same-origin production build.
  define: {
    __KIMI_DEV_PROXY_TARGET__: JSON.stringify(serverTarget),
    // Named backend presets for the Sidebar switcher menu (dev only).
    __KIMI_DEV_BACKENDS__: JSON.stringify(backendPresets),
    __KIMI_WEB_VERSION__: JSON.stringify(pkg.version),
    // True only for the web bundle embedded in the Kimi Desktop app (set by the
    // desktop-build workflow). Gates an "internal testing build" banner. When
    // false (default) the banner is tree-shaken out of the production bundle.
    __KIMI_WEB_DESKTOP__: JSON.stringify(process.env.KIMI_WEB_DESKTOP === '1'),
  },
  server: {
    port: webPort,
    strictPort: false,
    // Same-origin dev: the browser calls Vite, Vite forwards to the server.
    // No CORS anywhere. The real server serves REST + WS all under /api/v1.
    proxy: {
      '/api/v1': apiProxyOptions,
    },
  },
  // `vite preview` (the production build served locally) needs the same proxy —
  // bugs that only exist in production chunking (e.g. optional-peer-dep stubs)
  // can't be reproduced without running the built app against a server.
  // Preview intentionally stays on the static target: no runtime switcher.
  preview: {
    port: Number(process.env.WEB_PREVIEW_PORT) || 4175,
    proxy: {
      '/api/v1': apiProxyOptions,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
  // Workers that import modules with code-splitting (e.g. mermaid's dynamic
  // diagram imports) need ES format — IIFE cannot split chunks. The app
  // already targets ES2022 so all supported browsers handle module workers.
  worker: {
    format: 'es',
  },
});
