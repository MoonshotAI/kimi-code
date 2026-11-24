import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';

const root = fileURLToPath(new URL('./src/renderer', import.meta.url));
const outDir = fileURLToPath(new URL('./desktop-dist', import.meta.url));
const coreDir = fileURLToPath(new URL('../../kimi-code', import.meta.url));

function resolveCoreRef(): string {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: coreDir, encoding: 'utf8' }).trim();
    let branch = '';
    try {
      branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: coreDir, encoding: 'utf8' }).trim();
    } catch {
      branch = '';
    }
    return branch === '' ? commit : `${branch}@${commit}`;
  } catch {
    return '';
  }
}

const iconsDir = fileURLToPath(
  new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-client/package.json')),
);

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

const preset = kimiRendererViteConfig({
  root,
  iconsDir,
  defines: {
    __KIMI_DEV_PROXY_TARGET__: JSON.stringify(''),
    __KIMI_CLIENT_VERSION__: JSON.stringify(pkg.version),
    __KIMI_CORE_REF__: JSON.stringify(resolveCoreRef()),
    __KIMI_CODE_DESKTOP__: JSON.stringify(true),
  },
});

export default defineConfig({
  ...preset,
  root,
  publicDir: fileURLToPath(new URL('./src/renderer/public', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: false,
  },
  build: {
    ...preset.build,
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        browserOverlay: fileURLToPath(new URL('./src/renderer/browser-overlay.html', import.meta.url)),
        main: fileURLToPath(new URL('./src/renderer/index.html', import.meta.url)),
        browserControl: fileURLToPath(new URL('./src/renderer/browser-control.html', import.meta.url)),
        screenshot: fileURLToPath(new URL('./src/renderer/screenshot/index.html', import.meta.url)),
        captureHost: fileURLToPath(new URL('./src/renderer/capture-host/index.html', import.meta.url)),
        pin: fileURLToPath(new URL('./src/renderer/pin/index.html', import.meta.url)),
      },
    },
  },
});
