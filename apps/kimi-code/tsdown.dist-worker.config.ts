// Bundles the kap-server global-search worker
// (packages/kap-server/src/search/worker/entry.ts) into ONE self-contained
// `dist/search-worker.mjs` sibling of the main bundle. The search worker
// host resolves it at runtime next to `dist/main.mjs` (dev/tests use the TS
// source; the SEA binary uses the extracted asset from
// tsdown.worker.config.ts). Separate config because rolldown forbids
// `codeSplitting: false` with multiple inputs.

import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

const appRoot = import.meta.dirname;

export default defineConfig({
  entry: {
    'search-worker': resolve(
      appRoot,
      '../../packages/kap-server/src/search/worker/entry.ts',
    ),
  },
  format: ['esm'],
  // Shares the main bundle's dist (never wipe it) and lands as
  // `dist/search-worker.mjs`.
  outDir: 'dist',
  clean: false,
  dts: false,
  hash: false,
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  minify: false,
  silent: true,
  deps: {
    onlyBundle: false,
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: '[name].mjs',
  },
});
