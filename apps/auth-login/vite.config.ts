import { defineConfig } from 'vite';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';
import { fileURLToPath } from 'node:url';

// Dev/preview port for the standalone auth-login page.
const port = Number(process.env.AUTH_LOGIN_PORT) || 5176;

// Shared renderer preset (Vue plugin, unplugin-icons `kimi` collection sourced
// from app-client's icon dir, ES2022 target). This page talks directly to the
// OAuth host (CORS is open), so the OAuth flow needs no dev proxy.
const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  iconsDir: fileURLToPath(
    new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-client/package.json')),
  ),
  defines: {
    // This bundle never ships inside the desktop app (shared sources read the
    // flag through a `typeof` guard, so this stays `false` everywhere).
    __KIMI_WEB_DESKTOP__: JSON.stringify(false),
  },
});

// Optional session-API proxy for local development: the page's /auth/* calls
// are same-origin relatives, so a standalone dev/preview server has no
// backend for them (and the SPA fallback would answer 200 HTML for /auth/me,
// faking a session). Set AUTH_LOGIN_RELAY_URL to a running relay (e.g.
// http://127.0.0.1:8080) to proxy /auth to it; kept in sync for dev+preview.
const relayUrl = process.env.AUTH_LOGIN_RELAY_URL;
const authProxy = relayUrl ? { '/auth': { target: relayUrl, changeOrigin: true } } : undefined;

export default defineConfig({
  ...preset,
  // Relative asset URLs: the bundle can be mounted at any path on the RC
  // tunnel host without a rebuild.
  base: './',
  build: {
    ...preset.build,
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: false,
    proxy: authProxy,
  },
  preview: {
    port: Number(process.env.AUTH_LOGIN_PREVIEW_PORT) || 4176,
    proxy: authProxy,
  },
});
