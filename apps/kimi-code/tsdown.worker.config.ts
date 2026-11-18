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
      alwaysBundle: [/^@moonshot-ai\//],
    },
    clean: false,
  });
}

export default [
  workerConfig('text-build-worker', '../../packages/minidb/src/worker/text-build-worker.ts'),
  workerConfig('search-worker', '../../packages/kap-server/src/search/worker/entry.ts'),
];
