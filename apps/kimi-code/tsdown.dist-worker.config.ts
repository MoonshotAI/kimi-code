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
