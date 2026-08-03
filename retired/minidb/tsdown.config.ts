import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/cluster/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: [],
  },
});
