// Dedicated tsdown config that bundles the minidb text-build worker
// (packages/minidb/src/worker/text-build-worker.ts) and its whole import
// closure into ONE self-contained plain-JS ESM file. The SEA single-file
// binary embeds it as an asset (scripts/native/02-sea-blob.mjs) and spawns a
// real worker thread from it at runtime (src/native/minidb-worker.ts);
// without it the bundled binary has no worker entry file on disk and heavy
// text-index builds degrade to the inline main-thread core, stalling the
// event loop on large corpora.

import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

const here = import.meta.dirname;

export default defineConfig({
  entry: [resolve(here, '../../packages/minidb/src/worker/text-build-worker.ts')],
  format: ['esm'],
  outDir: resolve(here, 'dist-native/intermediates'),
  entryFileNames: 'text-build-worker.mjs',
  codeSplitting: false,
  platform: 'node',
  target: 'node24',
  dts: false,
  sourcemap: false,
  minify: false,
  silent: true,
  // The intermediates dir also holds main.cjs & co. — never wipe it.
  clean: false,
});
