import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';

const root = fileURLToPath(new URL('./src/renderer', import.meta.url));
const outDir = fileURLToPath(new URL('./web-dist', import.meta.url));
const webPort = Number(process.env.WEB_PORT) || 5175;
const serverTarget = process.env.KIMI_SERVER_URL || 'http://127.0.0.1:58627';

const iconsDir = fileURLToPath(
  new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-ui/package.json')),
);

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

function readCliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../kimi-code/package.json', import.meta.url), 'utf-8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    throw new Error('读取 CLI 版本失败：未找到 apps/kimi-code/package.json。');
  }
}

const preset = kimiRendererViteConfig({
  root,
  iconsDir,
  defines: {
    __KIMI_DEV_PROXY_TARGET__: JSON.stringify(serverTarget),
    __KIMI_CLIENT_VERSION__: JSON.stringify(readCliVersion()),
    __KIMI_CODE_DESKTOP__: JSON.stringify(false),
  },
});

const emptyComponentStub = fileURLToPath(
  new URL('./src/renderer/web-stubs/EmptyComponent.vue', import.meta.url),
);

export default defineConfig({
  ...preset,
  resolve: {
    alias: [
      {
        find: /^.*\/terminal\/(TerminalPanel|TerminalDropZone|TerminalResizeHandle|PanelTermTab)\.vue$/,
        replacement: emptyComponentStub,
      },
      { find: /^.*\/browser\/PanelBrowserTab\.vue$/, replacement: emptyComponentStub },
      { find: /^.*\/TerminalFontPreview\.vue$/, replacement: emptyComponentStub },
      {
        find: /^.*\/lib\/remoteControlQr$/,
        replacement: fileURLToPath(
          new URL('./src/renderer/web-stubs/remoteControlQr.ts', import.meta.url),
        ),
      },
    ],
  },
  plugins: [
    ...(preset.plugins ?? []),
    rcDevicesStubPlugin(),
    {
      name: 'kimi-web-html-variant',
      transformIndexHtml(html) {
        return html.replace('<title>Kimi Code</title>', '<title>Kimi Code Web</title>');
      },
    },
  ],
  build: {
    ...preset.build,
    outDir,
    emptyOutDir: true,
  },
  server: {
    port: webPort,
    strictPort: false,
    proxy: {
      '/api/v1': { target: serverTarget, changeOrigin: true, ws: true },
      '/api/v2': { target: serverTarget, changeOrigin: true },
    },
  },
  preview: {
    port: Number(process.env.WEB_PREVIEW_PORT) || 4175,
    proxy: {
      '/api/v1': { target: serverTarget, changeOrigin: true, ws: true },
      '/api/v2': { target: serverTarget, changeOrigin: true },
    },
  },
});
