import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts', './src/transports/ipc/index.ts', './src/transports/memory/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: [],
  },
});
