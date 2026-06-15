import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';
import { BUILT_IN_CATALOG_DEFINE, builtInCatalogDefine } from './scripts/built-in-catalog.mjs';

const appRoot = import.meta.dirname;

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
    // `@moonshot-ai/*` workspace packages bundle in. `hono` + `@hono/node-server`
    // are transitive deps of the bundled `@moonshot-ai/vis-server` (pulled in by
    // `kimi vis`); force-bundle them so the emitted `dist/main.mjs` is fully
    // self-contained and never `import`s them at runtime.
    alwaysBundle: [/^@moonshot-ai\//, 'hono', '@hono/node-server'],
    neverBundle: [],
    onlyBundle: false,
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'main.mjs',
  },
});
