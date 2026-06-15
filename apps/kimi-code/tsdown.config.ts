import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { BUILT_IN_CATALOG_DEFINE, builtInCatalogDefine } from './scripts/built-in-catalog.mjs';

const appRoot = import.meta.dirname;
const bundledRuntimeDependencies = new Set([
  '@earendil-works/pi-tui',
  'chalk',
  'cli-highlight',
  'commander',
  'pathe',
  'semver',
  'smol-toml',
  'zod',
]);

function shouldAlwaysBundle(id: string): boolean {
  if (id.startsWith('@moonshot-ai/')) return true;
  for (const dependency of bundledRuntimeDependencies) {
    if (id === dependency || id.startsWith(`${dependency}/`)) return true;
  }
  return false;
}

export default defineConfig({
  entry: ['./src/main.ts'],
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  dts: false,
  hash: false,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  plugins: [rawTextPlugin()],
  alias: {
    '@': resolve(appRoot, 'src'),
  },
  define: {
    [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
  },
  deps: {
    alwaysBundle: shouldAlwaysBundle,
    neverBundle: [
      '@mariozechner/clipboard',
      'koffi',
      'bufferutil',
      'utf-8-validate',
      'canvas',
      'chokidar',
    ],
    onlyBundle: false,
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'main.mjs',
  },
});
