import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };
const root = import.meta.dirname;

export default defineConfig({
  entry: ['./src/extension.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  plugins: [rawTextPlugin()],
  alias: {
    '@moonshot-ai/kimi-code-sdk': resolve(root, '../../packages/node-sdk/src/index.ts'),
    '@moonshot-ai/migration-legacy': resolve(root, '../../packages/migration-legacy/src/index.ts'),
    '@moonshot-ai/agent-core': resolve(root, '../../packages/agent-core/src/index.ts'),
    '@moonshot-ai/kaos': resolve(root, '../../packages/kaos/src/index.ts'),
    '@moonshot-ai/kimi-code-oauth': resolve(root, '../../packages/oauth/src/index.ts'),
    '@moonshot-ai/kosong': resolve(root, '../../packages/kosong/src/index.ts'),
  },
  define: {
    __EXTENSION_VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: [
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  deps: {
    onlyBundle: false,
    alwaysBundle: [/^@moonshot-ai\//, 'zod'],
    neverBundle: ['vscode'],
  },
  outputOptions: {
    entryFileNames: 'extension.js',
  },
});
