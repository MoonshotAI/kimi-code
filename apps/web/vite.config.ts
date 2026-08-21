import { defineConfig, type Plugin } from 'vite';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const webPort = Number(process.env.WEB_PORT) || 5175;
// Where the dev proxy forwards server traffic. Defaults to the local server
// (or `pnpm dev:stub`). Override to point dev at another server instance.
const serverTarget = process.env.KIMI_SERVER_URL || 'http://127.0.0.1:58627';

// Dev-only rc relay stub: with KIMI_RC_DEVICES_STUB=1 the dev server answers
// GET /v1/remote/devices with sample rows so the sidebar's rc device switcher
// can be verified locally (in production that endpoint lives on the rc relay,
// which the dev proxy knows nothing about). Never added to preview.
function rcDevicesStubPlugin(): Plugin {
  return {
    name: 'kimi-rc-devices-stub',
    configureServer(server) {
      if (process.env.KIMI_RC_DEVICES_STUB !== '1') return;
      server.middlewares.use('/v1/remote/devices', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            devices: [
              {
                alias: 'dev',
                client_version: 'kimi-code/0.37.2',
                created_at: '2026-08-18T17:55:50+08:00',
                device_id: '64831054-69a7-4363-93bc-7cea8abbd417',
                last_remote_access_at: '',
                local_base_url: 'http://127.0.0.1:58628',
                platform: 'linux',
                status: 'online',
                updated_at: '2026-08-20T18:33:55+08:00',
              },
              {
                alias: 'e2e-device',
                client_version: 'kimi-code/0.0.0-e2e',
                created_at: '2026-07-16T14:43:12+08:00',
                device_id: 'whz-e2e-device',
                last_remote_access_at: '',
                local_base_url: 'http://127.0.0.1:5494',
                platform: 'linux',
                status: 'offline',
                updated_at: '2026-08-17T12:34:22+08:00',
              },
            ],
            max_devices: 5,
          }),
        );
      });
    },
  };
}

// The web bundle ships inside the Kimi Code CLI (apps/web/dist is synced to
// apps/kimi-code/dist-web in the kimi-code submodule), so the version the UI
// shows — and reports to the daemon as clientVersion — is the CLI's version,
// not the workspace package's own (apps/web/package.json is a dev-only
// artifact). Sourced from the submodule checkout.
function readCliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../kimi-code/apps/kimi-code/package.json', import.meta.url), 'utf-8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    throw new Error(
      '读取 CLI 版本失败：未找到 kimi-code/apps/kimi-code/package.json——先运行 `pnpm run sync` 初始化 submodule。',
    );
  }
}

// Shared renderer config (Vue + unplugin-icons `kimi` collection, ES2022 target,
// module workers, `__KIMI_*` defines) lives in `@moonshot-ai/vite-preset` so the
// web and desktop renderers stay in lockstep. Web-only concerns (dev/preview
// proxy, build output dir) are layered on top below.
const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  iconsDir: fileURLToPath(
    new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-client/package.json')),
  ),
  // Expose the dev proxy's upstream server target to the client so the UI can
  // show which server it is connected to (the browser otherwise only sees its
  // own same-origin URL). Unused by the same-origin production build.
  defines: {
    __KIMI_DEV_PROXY_TARGET__: JSON.stringify(serverTarget),
    __KIMI_CLIENT_VERSION__: JSON.stringify(readCliVersion()),
    // True only for the web bundle embedded in the Kimi Desktop app (set by the
    // desktop-build workflow). Gates an "internal testing build" banner. When
    // false (default) the banner is tree-shaken out of the production bundle.
    __KIMI_WEB_DESKTOP__: JSON.stringify(process.env.KIMI_WEB_DESKTOP === '1'),
  },
});

export default defineConfig({
  ...preset,
  plugins: [...(preset.plugins ?? []), rcDevicesStubPlugin()],
  build: {
    ...preset.build,
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: webPort,
    strictPort: false,
    // Same-origin dev: the browser calls Vite, Vite forwards to the server.
    // No CORS anywhere. The real server serves REST + WS under /api/v1, plus
    // the /api/v2 session-list query (no WS there).
    proxy: {
      '/api/v1': { target: serverTarget, changeOrigin: true, ws: true },
      '/api/v2': { target: serverTarget, changeOrigin: true },
    },
  },
  // `vite preview` (the production build served locally) needs the same proxy —
  // bugs that only exist in production chunking (e.g. optional-peer-dep stubs)
  // can't be reproduced without running the built app against a server.
  preview: {
    port: Number(process.env.WEB_PREVIEW_PORT) || 4175,
    proxy: {
      '/api/v1': { target: serverTarget, changeOrigin: true, ws: true },
      '/api/v2': { target: serverTarget, changeOrigin: true },
    },
  },
});
