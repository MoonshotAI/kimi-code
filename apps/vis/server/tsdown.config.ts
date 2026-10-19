import { defineConfig } from 'tsdown';

import { rawTextPlugin } from '../../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: { server: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  deps: {
    alwaysBundle: [/^@moonshot-ai\/agent-core-v2/],
  },
});
