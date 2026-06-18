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
    alwaysBundle: [/^@moonshot-ai\//],
    // node-pty is a native addon: its `pty.node` binary cannot be bundled and
    // must resolve from node_modules at runtime. Keep it external (even though
    // its importer @moonshot-ai/agent-core is force-bundled above) and declare it
    // as a runtime dependency of this package so npm/npx installs it with its
    // prebuilt binary. Bundling it leaves the binary unresolvable → the terminal
    // PTY fails with "Failed to load native module: pty.node".
    neverBundle: ['node-pty'],
  },
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'main.mjs',
  },
});
