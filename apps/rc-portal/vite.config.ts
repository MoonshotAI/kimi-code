import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.AUTH_LOGIN_PORT) || 5176;

const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  iconsDir: fileURLToPath(
    new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-client/package.json')),
  ),
  defines: {
    __KIMI_CODE_DESKTOP__: JSON.stringify(false),
  },
});

const relayUrl = process.env.AUTH_LOGIN_RELAY_URL;
const authProxy = relayUrl
  ? {
      '/auth': { target: relayUrl, changeOrigin: true },
      '/devices': { target: relayUrl, changeOrigin: true, ws: true },
      '/v1/remote': { target: relayUrl, changeOrigin: true, ws: true },
    }
  : undefined;

const certFile = process.env.AUTH_LOGIN_CERT || undefined;
const keyFile = process.env.AUTH_LOGIN_KEY || undefined;
if ((certFile === undefined) !== (keyFile === undefined)) {
  throw new Error('AUTH_LOGIN_CERT and AUTH_LOGIN_KEY must be set together');
}
const https = certFile && keyFile
  ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
  : undefined;

export default defineConfig({
  ...preset,
  base: '/',
  build: {
    ...preset.build,
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: false,
    https,
    proxy: authProxy,
  },
  preview: {
    port: Number(process.env.AUTH_LOGIN_PREVIEW_PORT) || 4176,
    https,
    proxy: authProxy,
  },
});
