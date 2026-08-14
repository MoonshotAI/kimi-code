import { defineConfig } from 'vite';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';
import { fileURLToPath } from 'node:url';

// Dev/preview port for the standalone auth-login page.
const port = Number(process.env.AUTH_LOGIN_PORT) || 5176;

// Shared renderer preset (Vue plugin, unplugin-icons `kimi` collection sourced
// from app-client's icon dir, ES2022 target). This page talks directly to the
// OAuth host (CORS is open), so there is no dev proxy to layer on.
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
  },
  preview: {
    port: Number(process.env.AUTH_LOGIN_PREVIEW_PORT) || 4176,
  },
});
