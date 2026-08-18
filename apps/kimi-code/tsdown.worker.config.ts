// Dedicated tsdown config that bundles the off-main-thread workers into
// self-contained ESM files so they can ride the SEA blob as assets
// (02-sea-blob.mjs) and be spawned from disk at runtime:
//   - text-build-worker.mjs: the minidb text-build worker
//     (packages/minidb/src/worker/text-build-worker.ts);
//   - search-worker.mjs: the kap-server global-search worker
//     (packages/kap-server/src/search/worker/entry.ts).
// Without them the bundled binary lacks the worker entry files on disk and
// heavy index work degrades to the inline main-thread cores, stalling the
// event loop on large corpora. Runs after the main bundle with clean:false
// so all verified files remain.
//
// One config per entry: rolldown forbids `codeSplitting: false` with
// multiple inputs, and each worker must be a single self-contained file
// (check-bundle.mjs enforces zero remaining externals/relative imports).

import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

const here = import.meta.dirname;

function workerConfig(name: string, entry: string) {
  return defineConfig({
    entry: { [name]: resolve(here, entry) },
    format: ['esm'],
    outDir: resolve(here, 'dist-native/intermediates'),
    entryFileNames: '[name].mjs',
    codeSplitting: false,
    platform: 'node',
    target: 'node24',
    dts: false,
    sourcemap: false,
    minify: false,
    silent: true,
    deps: {
      // Force-bundle the workspace packages the entries import
      // (`@moonshot-ai/minidb` and its subpaths) so the output is
      // self-contained.
      alwaysBundle: [/^@moonshot-ai\//],
    },
    // The intermediates dir also holds main.cjs & co. — never wipe it.
    clean: false,
  });
}

export default [
  workerConfig('text-build-worker', '../../packages/minidb/src/worker/text-build-worker.ts'),
  workerConfig('search-worker', '../../packages/kap-server/src/search/worker/entry.ts'),
];
