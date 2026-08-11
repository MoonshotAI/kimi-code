import { readFileSync } from 'node:fs';
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

// iconsDir: the `kimi` icon collection lives in @moonshot-ai/app-client
// (src/icons/kimi); resolve the package's own package.json (explicitly
// exported — exports-map packages reject import.meta.resolve of undeclared
// subpaths) and derive the svg dir from it. SVGs are bundled into
// desktop-dist at build time, so the packaged app reads no workspace paths.
const iconsDir = fileURLToPath(
  new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-client/package.json')),
);

// The renderer reports this version to the server as its clientVersion. Read
// it from the desktop package.json (same idiom as apps/web/vite.config.ts) so
// it can never drift from the main process's app.getVersion().
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

const preset = kimiRendererViteConfig({
  root,
  iconsDir,
  defines: {
    // The renderer bundle is a copy of apps/web/src, which references four
    // compile-time `__KIMI_*` defines (see apps/web/src/env.d.ts). The preset
    // injects __KIMI_BUILD_TIME__; provide the other three so the copy builds
    // unchanged:
    //   __KIMI_DEV_PROXY_TARGET__ — desktop talks to the loopback server
    //     directly, never through the web dev proxy, so leave it empty.
    //   __KIMI_CLIENT_VERSION__ — reported to the server as the renderer's
    //     clientVersion; sourced from the desktop package.json (see above).
    //   __KIMI_WEB_DESKTOP__ — enables desktop-only behaviour in the web copy
    //     (theme IPC, openExternal, desktop flag), so force it true here.
    __KIMI_DEV_PROXY_TARGET__: JSON.stringify(''),
    __KIMI_CLIENT_VERSION__: JSON.stringify(pkg.version),
    __KIMI_WEB_DESKTOP__: JSON.stringify(true),
  },
});

export default defineConfig({
  ...preset,
  root,
  // No `public/` dir for the desktop renderer; silence Vite's missing-public
  // warning and avoid copying anything unexpected into the bundle.
  publicDir: false,
  // Dev server used by `pnpm dev` (scripts/dev.mjs) for renderer HMR. Pinned to
  // loopback; the port is a stable default (localStorage sticks across restarts)
  // but not strict — dev.mjs reads the actual port after listen and hands it to
  // Electron via KIMI_RENDERER_DEV_URL.
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
      // The preset sets no input of its own, so this is the only source.
      input: {
        main: fileURLToPath(new URL('./src/renderer/index.html', import.meta.url)),
      },
    },
  },
});
