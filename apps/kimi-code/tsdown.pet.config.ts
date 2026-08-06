import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const appRoot = import.meta.dirname;

/**
 * Separate bundle for the pet overlay (`kimi pet`). It runs under the
 * Electron binary — not Node — so it gets its own single-file build instead
 * of a second entry in the main config (`codeSplitting: false` forbids
 * multiple entries). Built after the main bundle; `clean: false` keeps the
 * main `dist/main.mjs` intact.
 */
export default defineConfig({
  entry: ['./src/pet/overlay/pet-overlay.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: false,
  dts: false,
  hash: false,
  plugins: [rawTextPlugin()],
  alias: {
    '@': resolve(appRoot, 'src'),
  },
  deps: {
    onlyBundle: false,
    // Provided by the Electron binary at runtime; intentionally not an npm
    // dependency of this package.
    neverBundle: ['electron'],
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'pet-overlay.mjs',
  },
});
