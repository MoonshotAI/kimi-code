import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';

// Bundler config is shared via `@moonshot-ai/vite-preset` (Vue + unplugin-icons
// `kimi` collection, ES2022 target, module workers, `__KIMI_*` defines) so the
// web and desktop renderers stay in lockstep. Desktop-only concerns (entry,
// output dir, desktop define) are layered on top here — do NOT fork
// apps/web/vite.config.ts.
//
// `root` is the directory that holds `index.html` (Vite's SPA entry), i.e.
// `src/renderer`. (The task brief's literal `root: __dirname` is not valid in
// an ESM config and would emit `desktop-dist/src/renderer/index.html`, breaking
// the `app://renderer/index.html` mapping — so `root` points at the entry dir,
// and `outDir` is pinned absolutely back to `apps/desktop/desktop-dist`.)
const root = fileURLToPath(new URL('./src/renderer', import.meta.url));
const outDir = fileURLToPath(new URL('./desktop-dist', import.meta.url));

// iconsDir: the web source tree (including src/icons/kimi) is now copied into
// src/renderer (desktop and web maintain two copies for now, on purpose), so
// point iconsDir at the in-tree copy. SVGs are bundled into desktop-dist at
// build time, so the packaged app does not depend on apps/web's filesystem.
const iconsDir = fileURLToPath(new URL('./src/renderer/icons/kimi', import.meta.url));

const preset = kimiRendererViteConfig({
  root,
  iconsDir,
  defines: {
    // The renderer bundle is a copy of apps/web/src, which references three
    // compile-time `__KIMI_*` defines (see apps/web/src/env.d.ts). Provide all
    // three so the copy builds unchanged:
    //   __KIMI_DEV_PROXY_TARGET__ — desktop talks to the loopback server
    //     directly, never through the web dev proxy, so leave it empty.
    //   __KIMI_WEB_VERSION__ — shown in the web UI; mirror the desktop version.
    //   __KIMI_WEB_DESKTOP__ — enables desktop-only behaviour in the web copy
    //     (theme IPC, openExternal, desktop flag), so force it true here.
    __KIMI_DEV_PROXY_TARGET__: JSON.stringify(''),
    __KIMI_WEB_VERSION__: JSON.stringify('0.1.1-internal.0'),
    __KIMI_WEB_DESKTOP__: JSON.stringify(true),
  },
});

export default defineConfig({
  ...preset,
  root,
  // No `public/` dir for the desktop renderer; silence Vite's missing-public
  // warning and avoid copying anything unexpected into the bundle.
  publicDir: false,
  build: {
    ...preset.build,
    outDir,
    emptyOutDir: true,
  },
});
