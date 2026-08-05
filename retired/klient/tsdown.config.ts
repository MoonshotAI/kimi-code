import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts', './src/transports/rust/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: ['@moonshot-ai/kimi-i18n'],
  },
});