import { fileURLToPath } from 'node:url';

import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  alias: {
    '@moonshot-ai/kimi-code-sdk': fileURLToPath(
      new URL('../node-sdk/src/index.ts', import.meta.url),
    ),
    '@moonshot-ai/agent-core': fileURLToPath(
      new URL('../agent-core/src/index.ts', import.meta.url),
    ),
    '@moonshot-ai/protocol': fileURLToPath(
      new URL('../protocol/src/index.ts', import.meta.url),
    ),
  },
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: [],
  },
});
