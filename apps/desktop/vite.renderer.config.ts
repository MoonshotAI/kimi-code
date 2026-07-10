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

// Decision 1 (iconsDir): inline the shared web SVG collection at build time.
// Resolved as an absolute path against this config file; the SVGs are bundled
// into `desktop-dist`, so the packaged app does not depend on apps/web's
// filesystem at runtime. Fallback (only if this absolute path breaks the build):
// copy apps/web/src/icons/kimi into src/renderer/icons/kimi and point iconsDir
// there (accept duplicated icons to avoid a cross-app filesystem dependency).
const iconsDir = fileURLToPath(new URL('../web/src/icons/kimi', import.meta.url));

const preset = kimiRendererViteConfig({
  root,
  iconsDir,
  defines: {
    // Desktop renderer flag. Deliberately NO `__KIMI_DEV_PROXY_TARGET__`: the
    // desktop renderer talks to the loopback server directly (same machine),
    // not through the web dev proxy.
    __KIMI_DESKTOP__: JSON.stringify(true),
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
