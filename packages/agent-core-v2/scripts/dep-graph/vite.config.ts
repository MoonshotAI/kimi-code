import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { depGraphPlugin } from './plugin/virtual-dep-graph';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Dev-only Vite config for the `dep-graph` viewer. Rooted inside
 * `scripts/dep-graph/web/` so it never touches `src/` or `dist/`; the
 * frontend imports the analyzer output through the `virtual:dep-graph`
 * plugin below.
 */
export default defineConfig({
  root: resolve(here, 'web'),
  cacheDir: resolve(here, '.vite'),
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5187,
    strictPort: false,
  },
  plugins: [react(), depGraphPlugin()],
  build: {
    // Not shipped anywhere — never invoked, but guard against accidental
    // `vite build` producing output inside src/.
    outDir: resolve(here, '.local', 'web-dist'),
    emptyOutDir: true,
  },
});
